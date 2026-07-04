import http from 'node:http';
import type { Agentbox } from '../agentbox.js';
import type { RunRequest } from '../types.js';

export interface HttpServerOptions {
  /**
   * Bearer/API keys accepted on every endpoint. When omitted the server is
   * open — only do that behind a trusted network boundary.
   */
  apiKeys?: string[];
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
export function createHttpServer(box: Agentbox, opts: HttpServerOptions = {}): http.Server {
  const apiKeys = new Set(opts.apiKeys ?? []);
  return http.createServer(async (req, res) => {
    try {
      if (apiKeys.size > 0 && !isAuthorized(req, apiKeys)) {
        return sendJson(res, 401, { error: 'unauthorized' });
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
        return sendJson(res, 200, box.listRuns());
      }
      if (req.method === 'GET' && req.url?.startsWith('/v1/runs/')) {
        const runId = decodeURIComponent(req.url.slice('/v1/runs/'.length));
        const run = box.getRun(runId);
        return sendJson(res, run ? 200 : 404, run ?? { error: 'run not found' });
      }
      if (req.method === 'POST' && req.url === '/v1/runs') {
        return await handleRun(box, req, res);
      }
      if (req.method === 'DELETE' && req.url?.startsWith('/v1/runs/')) {
        const runId = decodeURIComponent(req.url.slice('/v1/runs/'.length));
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

async function handleRun(box: Agentbox, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readBody(req);
  const request = parseRunRequest(body);
  if (!request) {
    return sendJson(res, 400, {
      error: 'expected body { session: { userId, goalId }, harness, prompt }',
    });
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

function isAuthorized(req: http.IncomingMessage, apiKeys: Set<string>): boolean {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ') && apiKeys.has(auth.slice('Bearer '.length))) return true;
  const headerKey = req.headers['x-api-key'];
  return typeof headerKey === 'string' && apiKeys.has(headerKey);
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
