import http from 'node:http';
import type { Agentbox } from '../agentbox.js';
import type { RunRequest } from '../types.js';

/**
 * Minimal HTTP facade.
 *  - GET    /v1/harnesses   : registered harness list
 *  - GET    /v1/stats       : session/queue status
 *  - POST   /v1/runs        : execute a run, streaming events over SSE
 *  - DELETE /v1/runs/{id}   : cancel a running or queued run
 */
export function createHttpServer(box: Agentbox): http.Server {
  return http.createServer(async (req, res) => {
    try {
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

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  try {
    await box.run(request, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.write(`data: ${JSON.stringify({ type: 'run:error', error: message })}\n\n`);
  }
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
