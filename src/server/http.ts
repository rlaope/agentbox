import http from 'node:http';
import type { Agentbox } from '../agentbox.js';
import type { RunRequest } from '../types.js';

export interface HttpServerOptions {
  /**
   * Bearer/API keys accepted on every endpoint. When omitted the server is
   * open — only do that behind a trusted network boundary.
   */
  apiKeys?: string[];
  /**
   * Keys with tenant bindings: a bound key can only start, query, and cancel
   * runs for its userIds / harnesses, so a leaked key exposes one tenant,
   * not the fleet. Combines with apiKeys (which stay unrestricted).
   */
  keys?: KeyBinding[];
}

export interface KeyBinding {
  key: string;
  /** When set, the key may only act for these userIds. */
  userIds?: string[];
  /** When set, the key may only start these harnesses. */
  harnesses?: string[];
}

/**
 * Minimal HTTP facade.
 *  - GET    /v1/harnesses   : registered harness list
 *  - GET    /v1/stats       : session/queue status
 *  - GET    /v1/runs        : recent finished runs (newest first)
 *  - GET    /v1/runs/{id}   : one finished run by id
 *  - POST   /v1/runs        : execute a run, streaming events over SSE
 *  - DELETE /v1/runs/{id}   : cancel a running or queued run
 *
 * Auth: pass `apiKeys`; requests must carry `Authorization: Bearer <key>`
 * or `x-api-key: <key>`.
 */
const UNRESTRICTED: KeyBinding = { key: '' };

export function createHttpServer(box: Agentbox, opts: HttpServerOptions = {}): http.Server {
  const bindings = new Map<string, KeyBinding>();
  for (const key of opts.apiKeys ?? []) bindings.set(key, UNRESTRICTED);
  for (const binding of opts.keys ?? []) bindings.set(binding.key, binding);
  const authRequired = bindings.size > 0;

  const userAllowed = (binding: KeyBinding, userId: string) =>
    !binding.userIds || binding.userIds.includes(userId);

  return http.createServer(async (req, res) => {
    try {
      let binding = UNRESTRICTED;
      if (authRequired) {
        const resolved = resolveBinding(req, bindings);
        if (!resolved) return sendJson(res, 401, { error: 'unauthorized' });
        binding = resolved;
      }
      if (req.method === 'GET' && req.url === '/v1/harnesses') {
        const list = box.harnesses().map((h) => ({
          name: h.name,
          backend: h.backend,
          description: h.description,
        }));
        return sendJson(res, 200, list);
      }
      if (req.method === 'GET' && req.url === '/v1/stats') {
        return sendJson(res, 200, box.stats);
      }
      if (req.method === 'GET' && req.url === '/v1/runs') {
        return sendJson(res, 200, box.listRuns().filter((run) => userAllowed(binding, run.session.userId)));
      }
      if (req.method === 'GET' && req.url?.startsWith('/v1/runs/')) {
        const runId = decodeURIComponent(req.url.slice('/v1/runs/'.length));
        const run = box.getRun(runId);
        if (!run || !userAllowed(binding, run.session.userId)) {
          return sendJson(res, 404, { error: 'run not found' });
        }
        return sendJson(res, 200, run);
      }
      if (req.method === 'POST' && req.url === '/v1/runs') {
        return await handleRun(box, req, res, binding);
      }
      if (req.method === 'DELETE' && req.url?.startsWith('/v1/runs/')) {
        const runId = decodeURIComponent(req.url.slice('/v1/runs/'.length));
        const owner = box.runSession(runId);
        if (!owner || !userAllowed(binding, owner.userId)) {
          return sendJson(res, 404, { error: 'run not found' });
        }
        const cancelled = box.cancel(runId);
        return sendJson(res, cancelled ? 200 : 404, cancelled ? { cancelled: true } : { error: 'run not found' });
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      } else {
        res.end();
      }
    }
  });
}

async function handleRun(
  box: Agentbox,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  binding: KeyBinding,
): Promise<void> {
  const body = await readBody(req);
  const request = parseRunRequest(body);
  if (!request) {
    return sendJson(res, 400, {
      error: 'expected body { session: { userId, goalId }, harness, prompt }',
    });
  }
  if (binding.userIds && !binding.userIds.includes(request.session.userId)) {
    return sendJson(res, 403, { error: `key is not allowed to act for user "${request.session.userId}"` });
  }
  if (binding.harnesses && !binding.harnesses.includes(request.harness)) {
    return sendJson(res, 403, { error: `key is not allowed to run harness "${request.harness}"` });
  }

  // Headers go out lazily on the first event, so pre-stream failures
  // (unknown harness, bad backend) can still return a proper status code.
  let streaming = false;
  const ensureStream = () => {
    if (streaming) return;
    streaming = true;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
  };
  try {
    await box.run(request, (event) => {
      ensureStream();
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!streaming) {
      return sendJson(res, /unknown harness/.test(message) ? 404 : 500, { error: message });
    }
    res.write(`data: ${JSON.stringify({ type: 'run:error', error: message })}\n\n`);
  }
  ensureStream();
  res.end();
}

function parseRunRequest(body: string): RunRequest | undefined {
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const userId = parsed?.session?.userId;
  const goalId = parsed?.session?.goalId;
  const harness = parsed?.harness;
  const prompt = parsed?.prompt;
  if ([userId, goalId, harness, prompt].some((v) => typeof v !== 'string' || v.length === 0)) {
    return undefined;
  }
  return { session: { userId, goalId }, harness, prompt };
}

function resolveBinding(req: http.IncomingMessage, bindings: Map<string, KeyBinding>): KeyBinding | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const binding = bindings.get(auth.slice('Bearer '.length));
    if (binding) return binding;
  }
  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string') return bindings.get(headerKey);
  return undefined;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}
