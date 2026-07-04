import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Agentbox } from '../src/agentbox.js';
import type { AgentDriver, DriverContext, DriverOutcome, RunEvent } from '../src/types.js';

/** Driver that finishes after a delay unless the run is aborted first. */
class SlowDriver implements AgentDriver {
  readonly backend = 'claude' as const;
  started = 0;

  constructor(private readonly delayMs: number) {}

  async run(ctx: DriverContext): Promise<DriverOutcome> {
    this.started++;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.delayMs);
      ctx.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    return ctx.signal.aborted
      ? { status: 'cancelled', finalText: '' }
      : { status: 'succeeded', finalText: 'done' };
  }
}

async function makeBox(driver: AgentDriver, maxConcurrentRuns = 4) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-cancel-'));
  const box = new Agentbox({ baseDir, maxConcurrentRuns, drivers: { claude: driver } });
  box.register({ name: 'slow-task', backend: 'claude' });
  return box;
}

function captureRunId(events: RunEvent[]): string {
  const start = events.find((e) => e.type === 'run:start');
  assert.ok(start && start.type === 'run:start');
  return start.runId;
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(check(), `condition not met within ${timeoutMs}ms`);
}

test('cancelling a running run kills it and reports cancelled', async () => {
  const driver = new SlowDriver(2000);
  const box = await makeBox(driver);
  const events: RunEvent[] = [];

  const pending = box.run(
    { session: { userId: 'u1', goalId: 'g' }, harness: 'slow-task', prompt: 'x' },
    (event) => events.push(event),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(box.cancel(captureRunId(events)), true);

  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(driver.started, 1);
  await box.close();
});

test('cancelling a queued run drops it before the driver ever starts', async () => {
  const driver = new SlowDriver(150);
  const box = await makeBox(driver, 1);
  const queuedEvents: RunEvent[] = [];

  const first = box.run({ session: { userId: 'u1', goalId: 'a' }, harness: 'slow-task', prompt: 'x' });
  // Only submit the second run once the first holds the single slot,
  // so the second is deterministically queued.
  await waitFor(() => driver.started === 1);
  const second = box.run(
    { session: { userId: 'u1', goalId: 'b' }, harness: 'slow-task', prompt: 'y' },
    (event) => queuedEvents.push(event),
  );
  await waitFor(() => queuedEvents.some((e) => e.type === 'run:start'));
  assert.equal(box.cancel(captureRunId(queuedEvents)), true);

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.status, 'succeeded');
  assert.equal(secondResult.status, 'cancelled');
  // Only the first run reached the driver.
  assert.equal(driver.started, 1);
  await box.close();
});

test('cancelling an unknown or finished run returns false', async () => {
  const driver = new SlowDriver(10);
  const box = await makeBox(driver);
  const events: RunEvent[] = [];
  await box.run({ session: { userId: 'u1', goalId: 'g' }, harness: 'slow-task', prompt: 'x' }, (e) => events.push(e));

  assert.equal(box.cancel('does-not-exist'), false);
  assert.equal(box.cancel(captureRunId(events)), false);
  await box.close();
});
