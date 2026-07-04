import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Agentbox } from '../src/agentbox.js';
import type { AgentDriver, DriverContext, DriverOutcome, RunEvent } from '../src/types.js';

/**
 * Driver double that records every prompt it is asked to run, so a test can
 * assert exactly which pipeline steps reached the backend (and how many times).
 */
class RecordingDriver implements AgentDriver {
  readonly backend = 'claude' as const;
  readonly prompts: string[] = [];

  constructor(private readonly reply: (ctx: DriverContext) => DriverOutcome = () => ({ status: 'succeeded', finalText: 'ok' })) {}

  async run(ctx: DriverContext, _emit: (event: RunEvent) => void): Promise<DriverOutcome> {
    this.prompts.push(ctx.prompt);
    return this.reply(ctx);
  }

  runsOf(prompt: string): number {
    return this.prompts.filter((p) => p === prompt).length;
  }
}

async function makeBox(driver: AgentDriver) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-hitl-'));
  const box = new Agentbox({ baseDir, drivers: { claude: driver } });
  box.register({ name: 'gen', backend: 'claude' });
  box.register({ name: 'review', backend: 'claude' });
  return box;
}

const SESSION = { userId: 'u1', goalId: 'g1' };

// --- pause / awaiting-approval ------------------------------------------------

test('a requireApproval step pauses the pipeline before that step runs', async () => {
  const driver = new RecordingDriver();
  const box = await makeBox(driver);

  const result = await box.runPipeline(SESSION, [
    { harness: 'gen', prompt: 'step1' },
    { harness: 'review', prompt: 'step2', requireApproval: true },
  ]);

  assert.equal(result.status, 'awaiting-approval');
  assert.equal(result.awaitingStep, 1);
  // Only the first step ran and is reported.
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].status, 'succeeded');
  assert.equal(result.steps[0].harness, 'gen');
  // The approval-gated step's driver was NOT invoked yet.
  assert.deepEqual(driver.prompts, ['step1']);
  assert.equal(driver.runsOf('step2'), 0);
  assert.ok(result.pipelineId);

  await box.close();
});

// --- approve resumes ----------------------------------------------------------

test('approvePipeline resumes and runs the gated step exactly once', async () => {
  const driver = new RecordingDriver();
  const box = await makeBox(driver);

  const paused = await box.runPipeline(SESSION, [
    { harness: 'gen', prompt: 'step1' },
    { harness: 'review', prompt: 'step2', requireApproval: true },
  ]);
  assert.equal(paused.status, 'awaiting-approval');

  const resumed = await box.approvePipeline(paused.pipelineId);

  assert.equal(resumed.status, 'succeeded');
  assert.equal(resumed.steps.length, 2);
  assert.deepEqual(
    resumed.steps.map((s) => s.harness),
    ['gen', 'review'],
  );
  assert.ok(resumed.steps.every((s) => s.status === 'succeeded'));
  assert.equal(resumed.awaitingStep, undefined);
  // step2 ran exactly once: not skipped, not doubled. step1 not re-run.
  assert.equal(driver.runsOf('step2'), 1);
  assert.equal(driver.runsOf('step1'), 1);
  assert.deepEqual(driver.prompts, ['step1', 'step2']);

  await box.close();
});

test('the same pipeline cannot be approved twice', async () => {
  const driver = new RecordingDriver();
  const box = await makeBox(driver);

  const paused = await box.runPipeline(SESSION, [
    { harness: 'gen', prompt: 'step1' },
    { harness: 'review', prompt: 'step2', requireApproval: true },
  ]);
  await box.approvePipeline(paused.pipelineId);
  await assert.rejects(() => box.approvePipeline(paused.pipelineId), /unknown or already-resolved/);

  await box.close();
});

// --- reject ends cancelled ----------------------------------------------------

test('rejectPipeline ends the pipeline cancelled with only the steps run so far', async () => {
  const driver = new RecordingDriver();
  const box = await makeBox(driver);

  const paused = await box.runPipeline(SESSION, [
    { harness: 'gen', prompt: 'step1' },
    { harness: 'review', prompt: 'step2', requireApproval: true },
  ]);
  assert.equal(paused.status, 'awaiting-approval');

  const rejected = box.rejectPipeline(paused.pipelineId);

  assert.equal(rejected.status, 'cancelled');
  assert.equal(rejected.pipelineId, paused.pipelineId);
  assert.deepEqual(rejected.session, SESSION);
  assert.equal(rejected.steps.length, 1);
  assert.equal(rejected.steps[0].harness, 'gen');
  // The gated step never ran.
  assert.equal(driver.runsOf('step2'), 0);
  // A rejected pipeline is resolved and cannot be approved afterward.
  await assert.rejects(() => box.approvePipeline(paused.pipelineId), /unknown or already-resolved/);

  await box.close();
});

// --- unknown pipeline ---------------------------------------------------------

test('approve/reject of an unknown pipelineId throws', async () => {
  const driver = new RecordingDriver();
  const box = await makeBox(driver);

  await assert.rejects(() => box.approvePipeline('does-not-exist'), /unknown or already-resolved/);
  assert.throws(() => box.rejectPipeline('does-not-exist'), /unknown or already-resolved/);

  await box.close();
});

// --- a pipeline with no gate runs straight through ----------------------------

test('a pipeline without requireApproval runs every step without pausing', async () => {
  const driver = new RecordingDriver();
  const box = await makeBox(driver);

  const result = await box.runPipeline(SESSION, [
    { harness: 'gen', prompt: 'a' },
    { harness: 'review', prompt: 'b' },
  ]);

  assert.equal(result.status, 'succeeded');
  assert.equal(result.steps.length, 2);
  assert.deepEqual(driver.prompts, ['a', 'b']);

  await box.close();
});
