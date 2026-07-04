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

async function makeServer(apiKeys?: string[], keys?: import('../src/server/http.js').KeyBinding[]) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-http-'));
  const box = new Agentbox({ baseDir, drivers: { claude: new OkDriver() } });
  box.register({ name: 'task', backend: 'claude' });
  box.register({ name: 'other', backend: 'claude' });
  const server = createHttpServer(box, { apiKeys, keys });
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

test('a tenant-bound key can only act for its userIds and harnesses', async () => {
  const { base, close } = await makeServer(undefined, [
    { key: 'tenant-a', userIds: ['alice'], harnesses: ['task'] },
  ]);
  const post = (key: string, userId: string, harness: string) =>
    fetch(`${base}/v1/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: JSON.stringify({ session: { userId, goalId: 'g' }, harness, prompt: 'x' }),
    });

  assert.equal((await post('tenant-a', 'alice', 'task')).status, 200);
  assert.equal((await post('tenant-a', 'bob', 'task')).status, 403); // wrong user
  assert.equal((await post('tenant-a', 'alice', 'other')).status, 403); // wrong harness
  assert.equal((await post('wrong-key', 'alice', 'task')).status, 401); // unknown key
  await close();
});

test('a bound key sees only its own runs in history and lookups', async () => {
  const { box, base, close } = await makeServer(undefined, [
    { key: 'key-a', userIds: ['alice'] },
    { key: 'key-b', userIds: ['bob'] },
  ]);
  const aliceRun = await box.run({ session: { userId: 'alice', goalId: 'g' }, harness: 'task', prompt: 'x' });
  const bobRun = await box.run({ session: { userId: 'bob', goalId: 'g' }, harness: 'task', prompt: 'x' });

  // key-a lists only alice's run and cannot fetch bob's by id.
  const aList = (await (await fetch(`${base}/v1/runs`, { headers: { authorization: 'Bearer key-a' } })).json()) as Array<{
    runId: string;
  }>;
  assert.deepEqual(aList.map((r) => r.runId), [aliceRun.runId]);
  assert.equal((await fetch(`${base}/v1/runs/${bobRun.runId}`, { headers: { authorization: 'Bearer key-a' } })).status, 404);
  assert.equal((await fetch(`${base}/v1/runs/${aliceRun.runId}`, { headers: { authorization: 'Bearer key-a' } })).status, 200);
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
