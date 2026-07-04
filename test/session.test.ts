import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LocalSandboxProvider } from '../src/sandbox/local.js';
import { SessionManager, sessionIdOf } from '../src/session/manager.js';
import type { SandboxKind, SandboxProvider } from '../src/types.js';

async function makeManager(opts?: { idleTtlMs?: number; maxSessions?: number }) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-test-'));
  const providers = new Map<SandboxKind, SandboxProvider>([
    ['local', new LocalSandboxProvider(baseDir)],
  ]);
  const manager = new SessionManager(providers, {
    idleTtlMs: opts?.idleTtlMs ?? 60_000,
    maxSessions: opts?.maxSessions ?? 8,
    sweepIntervalMs: 3_600_000,
  });
  return { manager, baseDir };
}

test('same (userId, goalId) reuses one session and workspace', async () => {
  const { manager } = await makeManager();
  const key = { userId: 'u1', goalId: 'deck' };
  const first = await manager.acquire(key, 'local');
  const second = await manager.acquire(key, 'local');
  assert.equal(first, second);
  assert.equal(manager.size, 1);
  await manager.close();
});

test('different goals get isolated workspaces', async () => {
  const { manager } = await makeManager();
  const a = await manager.acquire({ userId: 'u1', goalId: 'deck' }, 'local');
  const b = await manager.acquire({ userId: 'u1', goalId: 'report' }, 'local');
  assert.notEqual(a.sandbox.root, b.sandbox.root);
  await a.sandbox.writeFile('only-a.txt', 'a');
  const inB = await b.sandbox.collect(['**/*.txt']);
  assert.equal(inB.length, 0);
  await manager.close();
});

test('runs inside one session are serialized', async () => {
  const { manager } = await makeManager();
  const session = await manager.acquire({ userId: 'u1', goalId: 'deck' }, 'local');
  const order: string[] = [];
  const slow = session.runExclusive(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('slow');
  });
  const fast = session.runExclusive(async () => {
    order.push('fast');
  });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['slow', 'fast']);
  await manager.close();
});

test('a failed run does not wedge the session queue', async () => {
  const { manager } = await makeManager();
  const session = await manager.acquire({ userId: 'u1', goalId: 'deck' }, 'local');
  await assert.rejects(
    session.runExclusive(async () => {
      throw new Error('run failed');
    }),
  );
  const value = await session.runExclusive(async () => 'still alive');
  assert.equal(value, 'still alive');
  await manager.close();
});

test('idle sessions are evicted after ttl', async () => {
  const { manager } = await makeManager({ idleTtlMs: 1 });
  const session = await manager.acquire({ userId: 'u1', goalId: 'deck' }, 'local');
  await session.sandbox.writeFile('x.txt', 'x');
  await new Promise((resolve) => setTimeout(resolve, 10));
  await manager.sweep();
  assert.equal(manager.size, 0);
  await manager.close();
});

test('session id is filesystem-safe and collision-resistant', () => {
  const a = sessionIdOf({ userId: 'u/1', goalId: 'g 1' });
  const b = sessionIdOf({ userId: 'u', goalId: '1-g_1' });
  assert.match(a, /^[a-zA-Z0-9._-]+$/);
  assert.notEqual(a, b);
});
