import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Agentbox } from '../src/agentbox.js';
import { createGatewayServer } from '../src/cluster/gateway.js';
import { ConsistentHashRouter } from '../src/cluster/router.js';
import { createHttpServer } from '../src/server/http.js';
import type { AgentDriver, DriverContext, DriverOutcome } from '../src/types.js';

test('router is deterministic and reasonably balanced', () => {
  const router = new ConsistentHashRouter(['node-a', 'node-b', 'node-c']);
  const counts = new Map<string, number>();
  for (let i = 0; i < 3000; i++) {
    const node = router.nodeFor({ userId: `u${i}`, goalId: 'g' });
    assert.equal(node, router.nodeFor({ userId: `u${i}`, goalId: 'g' }));
    counts.set(node, (counts.get(node) ?? 0) + 1);
  }
  for (const node of ['node-a', 'node-b', 'node-c']) {
    const share = (counts.get(node) ?? 0) / 3000;
    assert.ok(share > 0.2 && share < 0.5, `${node} share ${share} out of balance`);
  }
});

test('removing a node only remaps that node\'s sessions', () => {
  const router = new ConsistentHashRouter(['node-a', 'node-b', 'node-c']);
  const before = new Map<string, string>();
  for (let i = 0; i < 1000; i++) {
    before.set(`u${i}`, router.nodeFor({ userId: `u${i}`, goalId: 'g' }));
  }
  router.remove('node-c');
  for (let i = 0; i < 1000; i++) {
    const now = router.nodeFor({ userId: `u${i}`, goalId: 'g' });
    const was = before.get(`u${i}`)!;
    if (was !== 'node-c') {
      assert.equal(now, was, `session on surviving node ${was} must not move`);
    } else {
      assert.notEqual(now, 'node-c');
    }
  }
});

class OkDriver implements AgentDriver {
  readonly backend = 'claude' as const;
  async run(_ctx: DriverContext): Promise<DriverOutcome> {
    return { status: 'succeeded', finalText: 'ok' };
  }
}

async function makeNode(name: string) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), `agentbox-node-${name}-`));
  const box = new Agentbox({ baseDir, drivers: { claude: new OkDriver() } });
  box.register({ name: 'task', backend: 'claude' });
  const server = createHttpServer(box);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { box, server, url };
}

test('gateway pins a session to one node and fans lookups out', async () => {
  const nodeA = await makeNode('a');
  const nodeB = await makeNode('b');
  const gateway = createGatewayServer([
    { id: 'a', url: nodeA.url },
    { id: 'b', url: nodeB.url },
  ]);
  await new Promise<void>((resolve) => gateway.listen(0, resolve));
  const base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;

  const runOnce = async (userId: string, goalId: string) => {
    const res = await fetch(`${base}/v1/runs`, {
      method: 'POST',
      body: JSON.stringify({ session: { userId, goalId }, harness: 'task', prompt: 'x' }),
    });
    assert.equal(res.status, 200);
    await res.text(); // drain the SSE stream
  };

  // Same session three times: exactly one node must have served all three.
  for (let i = 0; i < 3; i++) await runOnce('sticky-user', 'goal');
  const [aRuns, bRuns] = [nodeA.box.stats.totalRuns, nodeB.box.stats.totalRuns];
  assert.deepEqual([aRuns, bRuns].sort(), [0, 3]);

  // Many distinct sessions: both nodes get work.
  for (let i = 0; i < 12; i++) await runOnce(`user-${i}`, 'g');
  assert.ok(nodeA.box.stats.totalRuns > 0 && nodeB.box.stats.totalRuns > 0);

  // Run lookup through the gateway finds the run wherever it lives.
  const someRun = nodeA.box.stats.totalRuns > 0 ? nodeA.box.listRuns(1)[0] : nodeB.box.listRuns(1)[0];
  const byId = await fetch(`${base}/v1/runs/${someRun.runId}`);
  assert.equal(byId.status, 200);

  // Aggregated stats sum both nodes.
  const stats = (await (await fetch(`${base}/v1/stats`)).json()) as { total: { totalRuns: number } };
  assert.equal(stats.total.totalRuns, 15);

  await new Promise((r) => gateway.close(r));
  await new Promise((r) => nodeA.server.close(r));
  await new Promise((r) => nodeB.server.close(r));
  await nodeA.box.close();
  await nodeB.box.close();
});

test('gateway /stats degrades to partial results when a node is down', async () => {
  const nodeA = await makeNode('a');
  // Point the second node at a dead port so its fan-out request fails.
  const gateway = createGatewayServer([
    { id: 'a', url: nodeA.url },
    { id: 'b', url: 'http://127.0.0.1:1' },
  ]);
  await new Promise<void>((resolve) => gateway.listen(0, resolve));
  const base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;

  await nodeA.box.run({ session: { userId: 'u', goalId: 'g' }, harness: 'task', prompt: 'x' });

  const res = await fetch(`${base}/v1/stats`);
  assert.equal(res.status, 200);
  const stats = (await res.json()) as { total: { totalRuns: number }; nodes: Record<string, unknown> };
  // The live node's numbers still come through; the dead node is simply absent.
  assert.equal(stats.total.totalRuns, 1);
  assert.ok('a' in stats.nodes);
  assert.ok(!('b' in stats.nodes));

  await new Promise((r) => gateway.close(r));
  await new Promise((r) => nodeA.server.close(r));
  await nodeA.box.close();
});
