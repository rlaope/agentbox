import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Agentbox } from '../src/agentbox.js';
import { SnapshotManager } from '../src/sandbox/snapshots.js';
import type { AgentDriver, DriverContext, DriverOutcome } from '../src/types.js';

class ReadingDriver implements AgentDriver {
  readonly backend = 'claude' as const;
  async run(ctx: DriverContext): Promise<DriverOutcome> {
    const built = await fs.readFile(path.join(ctx.sandbox.root, 'build.txt'), 'utf8');
    return { status: 'succeeded', finalText: built.trim() };
  }
}

test('snapshot builds once (seed + prepare) and sessions clone from it', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-snap-'));
  const box = new Agentbox({ baseDir, drivers: { claude: new ReadingDriver() } });

  await box.snapshots.create(
    'deck-env',
    { seedFiles: { 'package.json': '{ "name": "deck" }' } },
    { prepare: ['sh', '-c', 'echo prepared > build.txt'] },
  );
  assert.deepEqual(await box.snapshots.list(), ['deck-env']);

  box.register({
    name: 'task',
    backend: 'claude',
    workspace: { snapshot: 'deck-env' },
  });
  const result = await box.run({ session: { userId: 'u', goalId: 'g' }, harness: 'task', prompt: 'x' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.finalText, 'prepared');

  // The clone is independent: the seeded file is present in the session too.
  const sessionPkg = path.join(baseDir, 'sessions', result.sessionId, 'package.json');
  assert.equal(await fs.readFile(sessionPkg, 'utf8'), '{ "name": "deck" }');
  await box.close();
});

test('unknown snapshot fails session creation with a clear error', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-snap-miss-'));
  const box = new Agentbox({ baseDir, drivers: { claude: new ReadingDriver() } });
  box.register({ name: 'task', backend: 'claude', workspace: { snapshot: 'nope' } });
  await assert.rejects(
    box.run({ session: { userId: 'u', goalId: 'g' }, harness: 'task', prompt: 'x' }),
    /unknown workspace snapshot "nope"/,
  );
  await box.close();
});

test('failed prepare never lands a snapshot; force rebuilds', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-snapmgr-'));
  const manager = new SnapshotManager(dir);

  await assert.rejects(manager.create('bad', {}, { prepare: ['sh', '-c', 'exit 1'] }), /failed/);
  assert.deepEqual(await manager.list(), []);

  await manager.create('env', { seedFiles: { 'v.txt': '1' } });
  await assert.rejects(manager.create('env', { seedFiles: { 'v.txt': '2' } }), /already exists/);
  await manager.create('env', { seedFiles: { 'v.txt': '2' } }, { force: true });
  assert.equal(await fs.readFile(path.join(dir, 'env', 'v.txt'), 'utf8'), '2');
  assert.equal(await manager.remove('env'), true);
  assert.equal(await manager.remove('env'), false);
});
