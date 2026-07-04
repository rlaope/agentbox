import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Agentbox } from '../src/agentbox.js';
import type { AgentDriver, DriverContext, DriverOutcome } from '../src/types.js';

class ResumeTrackingDriver implements AgentDriver {
  readonly backend = 'claude' as const;
  readonly seenResumeIds: Array<string | undefined> = [];

  async run(ctx: DriverContext): Promise<DriverOutcome> {
    this.seenResumeIds.push(ctx.state.resumeId);
    ctx.state.resumeId = 'session-abc';
    return { status: 'succeeded', finalText: 'ok' };
  }
}

const REQUEST = { session: { userId: 'u1', goalId: 'deck' }, harness: 'task', prompt: 'x' };

function makeBox(baseDir: string, driver: AgentDriver) {
  const box = new Agentbox({ baseDir, drivers: { claude: driver } });
  box.register({ name: 'task', backend: 'claude' });
  return box;
}

test('resume state survives a runtime restart via the workspace', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-persist-'));

  // First runtime: run once, then close WITHOUT destroying the workspace
  // (simulating a crash/restart, not a clean teardown).
  const driver1 = new ResumeTrackingDriver();
  const box1 = makeBox(baseDir, driver1);
  await box1.run(REQUEST);
  assert.deepEqual(driver1.seenResumeIds, [undefined]);
  // Do not call box1.close() — that reaps sessions. Just drop it.

  // Second runtime over the same baseDir: the session must come back warm.
  const driver2 = new ResumeTrackingDriver();
  const box2 = makeBox(baseDir, driver2);
  await box2.run(REQUEST);
  assert.deepEqual(driver2.seenResumeIds, ['session-abc']);
  await box2.close();
});

test('prewarmSessions creates workspaces ahead of the first run', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-prewarm-'));
  const box = makeBox(baseDir, new ResumeTrackingDriver());

  const ids = await box.prewarmSessions(
    [
      { userId: 'u1', goalId: 'deck' },
      { userId: 'u2', goalId: 'report' },
    ],
    { workspace: { seedFiles: { 'seed.txt': 'ready' } } },
  );
  assert.equal(ids.length, 2);
  assert.equal(box.stats.sessions, 2);

  const seeded = path.join(baseDir, 'sessions', ids[0], 'seed.txt');
  assert.equal(await fs.readFile(seeded, 'utf8'), 'ready');
  await box.close();
});
