import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Agentbox } from '../src/agentbox.js';
import { createHttpServer } from '../src/server/http.js';
import type { AgentDriver, DriverContext, DriverOutcome } from '../src/types.js';

class OkDriver implements AgentDriver {
  readonly backend = 'claude' as const;
  async run(_ctx: DriverContext): Promise<DriverOutcome> {
    return { status: 'succeeded', finalText: 'ok' };
  }
}

async function makeServer(apiKeys?: string[]) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-http-'));
  const box = new Agentbox({ baseDir, drivers: { claude: new OkDriver() } });
  box.register({ name: 'task', backend: 'claude' });
  const server = createHttpServer(box, { apiKeys });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  return {
    box,
    base,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await box.close();
    },
  };
}

test('requests without a valid key are rejected with 401', async () => {
  const { base, close } = await makeServer(['secret-key']);
  assert.equal((await fetch(`${base}/v1/stats`)).status, 401);
  assert.equal(
    (await fetch(`${base}/v1/stats`, { headers: { authorization: 'Bearer wrong' } })).status,
    401,
  );
  const bearer = await fetch(`${base}/v1/stats`, { headers: { authorization: 'Bearer secret-key' } });
  assert.equal(bearer.status, 200);
  const headerKey = await fetch(`${base}/v1/stats`, { headers: { 'x-api-key': 'secret-key' } });
  assert.equal(headerKey.status, 200);
  await close();
});

test('without configured keys the server stays open', async () => {
  const { base, close } = await makeServer();
  assert.equal((await fetch(`${base}/v1/harnesses`)).status, 200);
  await close();
});

test('finished runs are queryable by id and as a list', async () => {
  const { box, base, close } = await makeServer();
  const result = await box.run({ session: { userId: 'u', goalId: 'g' }, harness: 'task', prompt: 'x' });

  const byId = await fetch(`${base}/v1/runs/${result.runId}`);
  assert.equal(byId.status, 200);
  const fetched = (await byId.json()) as { runId: string; harness: string; status: string };
  assert.equal(fetched.runId, result.runId);
  assert.equal(fetched.harness, 'task');
  assert.equal(fetched.status, 'succeeded');

  const list = (await (await fetch(`${base}/v1/runs`)).json()) as Array<{ runId: string }>;
  assert.equal(list[0].runId, result.runId);

  assert.equal((await fetch(`${base}/v1/runs/nope`)).status, 404);
  await close();
});

test('unknown harness returns 404 before any stream starts', async () => {
  const { base, close } = await makeServer();
  const res = await fetch(`${base}/v1/runs`, {
    method: 'POST',
    body: JSON.stringify({ session: { userId: 'u', goalId: 'g' }, harness: 'nope', prompt: 'x' }),
  });
  assert.equal(res.status, 404);
  await close();
});
