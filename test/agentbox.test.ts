import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Agentbox } from '../src/agentbox.js';
import type { AgentDriver, DriverContext, DriverOutcome, RunEvent } from '../src/types.js';

/** 실제 CLI 없이 코어 사이클을 검증하기 위한 테스트 더블 */
class FakeDriver implements AgentDriver {
  readonly backend = 'claude' as const;
  readonly seenResumeIds: Array<string | undefined> = [];

  async run(ctx: DriverContext, emit: (event: RunEvent) => void): Promise<DriverOutcome> {
    this.seenResumeIds.push(ctx.state.resumeId);
    ctx.state.resumeId = 'resume-123';
    emit({ type: 'agent:message', text: 'working' });
    await ctx.sandbox.writeFile('out/result.txt', `done: ${ctx.prompt}`);
    return { status: 'succeeded', finalText: 'done' };
  }
}

async function makeBox(driver: AgentDriver) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-e2e-'));
  const box = new Agentbox({ baseDir, drivers: { claude: driver } });
  box.register({
    name: 'fake-task',
    backend: 'claude',
    artifacts: { globs: ['out/**'] },
  });
  return box;
}

test('run cycle: session acquire -> driver -> artifact collection', async () => {
  const driver = new FakeDriver();
  const box = await makeBox(driver);
  const events: RunEvent[] = [];

  const result = await box.run(
    { session: { userId: 'u1', goalId: 'deck' }, harness: 'fake-task', prompt: 'make it' },
    (event) => events.push(event),
  );

  assert.equal(result.status, 'succeeded');
  assert.equal(result.finalText, 'done');
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].path, 'out/result.txt');
  assert.deepEqual(
    events.map((e) => e.type),
    ['run:start', 'agent:message', 'run:done'],
  );
  await box.close();
});

test('same session key gets warm resume state on the second run', async () => {
  const driver = new FakeDriver();
  const box = await makeBox(driver);
  const request = { session: { userId: 'u1', goalId: 'deck' }, harness: 'fake-task', prompt: 'again' };

  await box.run(request);
  await box.run(request);

  assert.deepEqual(driver.seenResumeIds, [undefined, 'resume-123']);
  await box.close();
});

test('unknown harness is rejected', async () => {
  const box = await makeBox(new FakeDriver());
  await assert.rejects(
    box.run({ session: { userId: 'u1', goalId: 'g' }, harness: 'nope', prompt: 'x' }),
    /unknown harness/,
  );
  await box.close();
});
