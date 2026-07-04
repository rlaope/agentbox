import http from 'node:http';
import { ConsistentHashRouter } from './router.js';
import type { SessionKey } from '../types.js';

/**
 * Multi-node gateway. agentbox instances stay single-node (workspace and
 * resume state are node-local); the gateway routes each run to its session's
 * home node by consistent hash and fans lookups out across the fleet.
 *
 *  - POST   /v1/runs      : routed by (userId, goalId), SSE proxied through
 *  - GET    /v1/runs/{id} : fan-out, first node that knows the run answers
 *  - DELETE /v1/runs/{id} : fan-out cancel
 *  - GET    /v1/runs      : fan-out, merged
 *  - GET    /v1/stats     : fan-out, numeric fields summed per node + total
 *  - GET    /v1/harnesses : proxied to the first node
 */
export interface GatewayNode {
  id: string;
  /** Base URL of the node's agentbox HTTP facade, e.g. http://10.0.0.5:8787 */
  url: string;
}

export interface GatewayOptions {
  /** API keys the gateway itself requires from clients */
  apiKeys?: string[];
  /** API key the gateway presents to the nodes */
  nodeApiKey?: string;
  fetchImpl?: typeof fetch;
}

export function createGatewayServer(nodes: GatewayNode[], opts: GatewayOptions = {}): http.Server {
  if (nodes.length === 0) throw new Error('gateway needs at least one node');
  const router = new ConsistentHashRouter(nodes.map((n) => n.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const apiKeys = new Set(opts.apiKeys ?? []);
  const fetchImpl = opts.fetchImpl ?? fetch;

  const nodeHeaders = (): Record<string, string> =>
    opts.nodeApiKey ? { authorization: `Bearer ${opts.nodeApiKey}` } : {};

  return http.createServer(async (req, res) => {
    try {
      if (apiKeys.size > 0 && !isAuthorized(req, apiKeys)) {
        return sendJson(res, 401, { error: 'unauthorized' });
      }

      if (req.method === 'POST' && req.url === '/v1/runs') {
        const body = await readBody(req);
        const key = sessionKeyOf(body);
        if (!key) return sendJson(res, 400, { error: 'expected body { session: { userId, goalId }, ... }' });
        const node = byId.get(router.nodeFor(key))!;
        return await proxyStream(fetchImpl, `${node.url}/v1/runs`, body, nodeHeaders(), res);
      }

      if (req.method === 'GET' && req.url === '/v1/harnesses') {
        const upstream = await fetchImpl(`${nodes[0].url}/v1/harnesses`, { headers: nodeHeaders() });
        return sendJson(res, upstream.status, await upstream.json());
      }

      if (req.method === 'GET' && req.url === '/v1/stats') {
        const perNode: Record<string, unknown> = {};
        const total = { sessions: 0, runningRuns: 0, queuedRuns: 0, activeRuns: 0, totalRuns: 0 };
        for (const node of nodes) {
          const stats = (await (await fetchImpl(`${node.url}/v1/stats`, { headers: nodeHeaders() })).json()) as Record<
            string,
            number
          >;
          perNode[node.id] = stats;
          for (const field of Object.keys(total) as Array<keyof typeof total>) {
            total[field] += stats[field] ?? 0;
          }
        }
        return sendJson(res, 200, { total, nodes: perNode });
      }

      if (req.method === 'GET' && req.url === '/v1/runs') {
        const merged: unknown[] = [];
        for (const node of nodes) {
          const runs = (await (await fetchImpl(`${node.url}/v1/runs`, { headers: nodeHeaders() })).json()) as unknown[];
          merged.push(...runs);
        }
        return sendJson(res, 200, merged);
      }

      if ((req.method === 'GET' || req.method === 'DELETE') && req.url?.startsWith('/v1/runs/')) {
        for (const node of nodes) {
          const upstream = await fetchImpl(`${node.url}${req.url}`, {
            method: req.method,
            headers: nodeHeaders(),
          });
          if (upstream.status !== 404) return sendJson(res, upstream.status, await upstream.json());
        }
        return sendJson(res, 404, { error: 'run not found' });
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
      } else {
        res.end();
      }
    }
  });
}

async function proxyStream(
  fetchImpl: typeof fetch,
  url: string,
  body: string,
  headers: Record<string, string>,
  res: http.ServerResponse,
): Promise<void> {
  const upstream = await fetchImpl(url, { method: 'POST', body, headers });
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
    'cache-control': 'no-cache',
  });
  if (upstream.body) {
    for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      res.write(chunk);
    }
  }
  res.end();
}

function sessionKeyOf(body: string): SessionKey | undefined {
  try {
    const parsed = JSON.parse(body) as { session?: { userId?: unknown; goalId?: unknown } };
    const userId = parsed.session?.userId;
    const goalId = parsed.session?.goalId;
    if (typeof userId === 'string' && typeof goalId === 'string') return { userId, goalId };
  } catch {
    // fall through
  }
  return undefined;
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
