import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Agentbox, type AgentboxOptions } from '../src/agentbox.js';
import type { AgentDriver, DriverContext, DriverOutcome, HarnessSpec } from '../src/types.js';

// A driver double that writes some files into the sandbox and then returns a
// caller-chosen outcome. Mirrors the driver-double pattern in hardening.test.ts.
class WritingDriver implements AgentDriver {
  readonly backend = 'claude' as const;

  constructor(
    private readonly files: Record<string, string>,
    private readonly outcome: DriverOutcome = { status: 'succeeded', finalText: 'ok' },
  ) {}

  async run(ctx: DriverContext): Promise<DriverOutcome> {
    for (const [rel, content] of Object.entries(this.files)) {
      await ctx.sandbox.writeFile(rel, content);
    }
    return this.outcome;
  }
}

async function makeBox(driver: AgentDriver, harness: Partial<HarnessSpec> = {}, opts: Partial<AgentboxOptions> = {}) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-verify-'));
  const box = new Agentbox({ baseDir, drivers: { claude: driver }, ...opts });
  box.register({ name: 'task', backend: 'claude', ...harness });
  return box;
}

const REQUEST = { session: { userId: 'u1', goalId: 'g' }, harness: 'task', prompt: 'x' };

test('passing verify command marks the run succeeded and records verification', async () => {
  const driver = new WritingDriver({ 'out/x': 'hi' });
  const box = await makeBox(driver, { verify: { command: ['sh', '-c', 'test -f out/x'] } });

  const result = await box.run(REQUEST);
  assert.equal(result.status, 'succeeded');
  assert.ok(result.verification, 'verification should be present');
  assert.equal(result.verification?.passed, true);
  assert.equal(result.verification?.exitCode, 0);
  await box.close();
});

test('a required verify failure flips the run to failed', async () => {
  // Agent produced nothing under out/, so the check fails.
  const driver = new WritingDriver({ 'other.txt': 'hi' });
  const box = await makeBox(driver, { verify: { command: ['sh', '-c', 'test -f out/x'] } });

  const result = await box.run(REQUEST);
  assert.equal(result.status, 'failed');
  assert.ok(result.verification);
  assert.equal(result.verification?.passed, false);
  assert.equal(result.verification?.exitCode, 1);
  assert.match(result.error ?? '', /verification failed/);
  await box.close();
});

test('required:false keeps a failed verify from flipping the run', async () => {
  const driver = new WritingDriver({ 'other.txt': 'hi' });
  const box = await makeBox(driver, { verify: { command: ['sh', '-c', 'exit 1'], required: false } });

  const result = await box.run(REQUEST);
  assert.equal(result.status, 'succeeded');
  assert.ok(result.verification, 'verification is still recorded even when advisory');
  assert.equal(result.verification?.passed, false);
  assert.equal(result.verification?.exitCode, 1);
  // The run itself did not fail, so no verification error is set.
  assert.equal(result.error, undefined);
  await box.close();
});

test('verify only runs on succeeded outcomes', async () => {
  const driver = new WritingDriver({ 'out/x': 'hi' }, { status: 'failed', finalText: '', error: 'driver blew up' });
  const box = await makeBox(driver, { verify: { command: ['sh', '-c', 'test -f out/x'] } });

  const result = await box.run(REQUEST);
  assert.equal(result.status, 'failed');
  // The check would have passed (out/x exists) but must not run for a
  // non-succeeded outcome; verification stays undefined and the original
  // driver error survives.
  assert.equal(result.verification, undefined);
  assert.equal(result.error, 'driver blew up');
  await box.close();
});

test('with no verify spec the run carries no verification', async () => {
  const driver = new WritingDriver({ 'out/x': 'hi' });
  const box = await makeBox(driver);

  const result = await box.run(REQUEST);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.verification, undefined);
  await box.close();
});

test('verify command runs with cwd = workspace so it sees agent-written files', async () => {
  const marker = 'MAGIC-' + Math.random().toString(36).slice(2);
  const driver = new WritingDriver({ 'nested/data.txt': marker });
  // A relative path only resolves if cwd is the session workspace root; the
  // command also echoes the file so we can assert the captured output.
  const box = await makeBox(driver, { verify: { command: ['sh', '-c', 'cat nested/data.txt'] } });

  const result = await box.run(REQUEST);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.verification?.passed, true);
  assert.equal(result.verification?.output, marker);
  await box.close();
});

test('verify captures combined stdout/stderr from the check', async () => {
  const driver = new WritingDriver({ 'out/x': 'hi' });
  const box = await makeBox(driver, {
    // Write to stderr and exit non-zero: output is captured, run fails (required).
    verify: { command: ['sh', '-c', 'echo boom-detail 1>&2; exit 3'] },
  });

  const result = await box.run(REQUEST);
  assert.equal(result.status, 'failed');
  assert.equal(result.verification?.passed, false);
  assert.equal(result.verification?.exitCode, 3);
  assert.match(result.verification?.output ?? '', /boom-detail/);
  assert.match(result.error ?? '', /exit 3/);
  await box.close();
});

test('a required-verify failure blocks even when the driver reported success', async () => {
  // The verify layer is the last word on a "succeeded" run: the driver said ok,
  // but the sandbox check fails, so the run must fail closed.
  const driver = new WritingDriver({ 'out/x': 'hi' }, { status: 'succeeded', finalText: 'looks great' });
  const box = await makeBox(driver, { verify: { command: ['sh', '-c', 'exit 1'] } });

  const result = await box.run(REQUEST);
  assert.equal(result.status, 'failed');
  assert.equal(result.finalText, 'looks great'); // finalText is preserved
  assert.equal(result.verification?.passed, false);
  await box.close();
});
