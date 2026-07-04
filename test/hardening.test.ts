import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Agentbox, type AgentboxOptions } from '../src/agentbox.js';
import { FairScheduler, QueueFullError, QueueTimeoutError } from '../src/scheduler/scheduler.js';
import type { AgentDriver, DriverContext, DriverOutcome, HarnessSpec, RunEvent } from '../src/types.js';

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// --- scheduler backpressure -------------------------------------------------

test('queue full fails fast with QueueFullError', async () => {
  const scheduler = new FairScheduler(1, { maxQueued: 1 });
  const running = scheduler.schedule('a', () => tick(100));
  const queued = scheduler.schedule('a', () => tick(1));
  await assert.rejects(scheduler.schedule('a', () => tick(1)), QueueFullError);
  await Promise.all([running, queued]);
});

test('jobs stuck in the queue reject with QueueTimeoutError', async () => {
  const scheduler = new FairScheduler(1, { queueTimeoutMs: 20 });
  const running = scheduler.schedule('a', () => tick(120));
  await assert.rejects(scheduler.schedule('a', () => tick(1)), QueueTimeoutError);
  await running;
});

test('per-lane cap keeps one tenant from taking every slot', async () => {
  const scheduler = new FairScheduler(2, { maxPerLane: 1 });
  let aRunning = 0;
  let aPeak = 0;
  const job = (lane: string) =>
    scheduler.schedule(lane, async () => {
      if (lane === 'a') {
        aRunning++;
        aPeak = Math.max(aPeak, aRunning);
      }
      await tick(20);
      if (lane === 'a') aRunning--;
    });
  await Promise.all([job('a'), job('a'), job('a'), job('b')]);
  assert.equal(aPeak, 1);
});

// --- Agentbox-level hardening -------------------------------------------------

class ScriptedDriver implements AgentDriver {
  readonly backend = 'claude' as const;
  attempts = 0;

  constructor(private readonly script: (ctx: DriverContext, attempt: number) => Promise<DriverOutcome>) {}

  async run(ctx: DriverContext): Promise<DriverOutcome> {
    this.attempts++;
    return this.script(ctx, this.attempts);
  }
}

async function makeBox(driver: AgentDriver, harness: Partial<HarnessSpec> = {}, opts: Partial<AgentboxOptions> = {}) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-hardening-'));
  const box = new Agentbox({ baseDir, drivers: { claude: driver }, ...opts });
  box.register({ name: 'task', backend: 'claude', ...harness });
  return box;
}

const REQUEST = { session: { userId: 'u1', goalId: 'g' }, harness: 'task', prompt: 'x' };

test('retry policy re-runs failed attempts and emits run:retry', async () => {
  const driver = new ScriptedDriver(async (_ctx, attempt) =>
    attempt < 3
      ? { status: 'failed', finalText: '', error: `boom ${attempt}` }
      : { status: 'succeeded', finalText: 'ok' },
  );
  const box = await makeBox(driver, { retry: { maxAttempts: 3 } });
  const events: RunEvent[] = [];

  const result = await box.run(REQUEST, (e) => events.push(e));
  assert.equal(result.status, 'succeeded');
  assert.equal(driver.attempts, 3);
  assert.deepEqual(
    events.filter((e) => e.type === 'run:retry').map((e) => (e.type === 'run:retry' ? e.attempt : 0)),
    [2, 3],
  );
  await box.close();
});

test('exhausted retries surface the last failure', async () => {
  const driver = new ScriptedDriver(async () => ({ status: 'failed', finalText: '', error: 'always' }));
  const box = await makeBox(driver, { retry: { maxAttempts: 2 } });
  const result = await box.run(REQUEST);
  assert.equal(result.status, 'failed');
  assert.equal(driver.attempts, 2);
  await box.close();
});

test('workspace quota failure overrides a succeeded outcome', async () => {
  const driver = new ScriptedDriver(async (ctx) => {
    await ctx.sandbox.writeFile('big.bin', 'x'.repeat(1024));
    return { status: 'succeeded', finalText: 'done' };
  });
  const box = await makeBox(driver, { limits: { maxWorkspaceBytes: 100 } });
  const result = await box.run(REQUEST);
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /quota/);
  await box.close();
});

test('workspaceQuotaExcludes keeps excluded dirs out of the quota', async () => {
  const write = async (ctx: DriverContext): Promise<DriverOutcome> => {
    await ctx.sandbox.writeFile('node_modules/dep/big.bin', 'x'.repeat(1024));
    await ctx.sandbox.writeFile('out/deck.txt', 'small');
    return { status: 'succeeded', finalText: 'done' };
  };
  // Without the exclude, node_modules pushes the workspace over the quota.
  const strict = await makeBox(new ScriptedDriver(write), { limits: { maxWorkspaceBytes: 100 } });
  assert.equal((await strict.run(REQUEST)).status, 'failed');
  await strict.close();

  // With node_modules excluded, only out/ counts and the run passes.
  const lenient = await makeBox(new ScriptedDriver(write), {
    limits: { maxWorkspaceBytes: 100, workspaceQuotaExcludes: ['node_modules'] },
  });
  assert.equal((await lenient.run(REQUEST)).status, 'succeeded');
  await lenient.close();
});

test('RunResult.toolCalls counts tool:call events across the run', async () => {
  class EmittingDriver implements AgentDriver {
    readonly backend = 'claude' as const;
    async run(_ctx: DriverContext, emit: (e: RunEvent) => void): Promise<DriverOutcome> {
      emit({ type: 'tool:call', name: 'Read' });
      emit({ type: 'tool:call', name: 'Write' });
      emit({ type: 'agent:message', text: 'done' });
      emit({ type: 'tool:call', name: 'Read' });
      return { status: 'succeeded', finalText: 'ok' };
    }
  }
  const box = await makeBox(new EmittingDriver());
  const result = await box.run(REQUEST);
  assert.equal(result.toolCalls, 3);
  await box.close();
});

test('lifecycle hooks observe start, events, and end without breaking runs', async () => {
  const driver = new ScriptedDriver(async () => ({ status: 'succeeded', finalText: 'ok' }));
  const seen: string[] = [];
  const box = await makeBox(
    driver,
    {},
    {
      hooks: {
        onRunStart: ({ harness }) => void seen.push(`start:${harness.name}`),
        onEvent: (_runId, event) => void seen.push(`event:${event.type}`),
        onRunEnd: (result) => {
          seen.push(`end:${result.status}`);
          throw new Error('hooks must not break runs');
        },
      },
    },
  );
  const result = await box.run(REQUEST);
  assert.equal(result.status, 'succeeded');
  assert.ok(seen.includes('start:task'));
  assert.ok(seen.includes('event:run:start'));
  assert.ok(seen.includes('end:succeeded'));
  await box.close();
});

test('queue overflow surfaces as a failed result, not a thrown error', async () => {
  const driver = new ScriptedDriver(async (ctx) => {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 200);
      ctx.signal.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      });
    });
    return { status: 'succeeded', finalText: 'ok' };
  });
  const box = await makeBox(driver, {}, { maxConcurrentRuns: 1, maxQueuedRuns: 0 });

  const first = box.run(REQUEST);
  await tick(30);
  const second = await box.run({ ...REQUEST, session: { userId: 'u1', goalId: 'other' } });
  assert.equal(second.status, 'failed');
  assert.match(second.error ?? '', /queue is full/);
  assert.equal((await first).status, 'succeeded');
  await box.close();
});

test('close with drainMs waits for in-flight runs', async () => {
  const driver = new ScriptedDriver(async () => {
    await tick(80);
    return { status: 'succeeded', finalText: 'ok' };
  });
  const box = await makeBox(driver);
  const pending = box.run(REQUEST);
  await tick(10);
  await box.close({ drainMs: 2000 });
  assert.equal((await pending).status, 'succeeded');
});

test('stats aggregates run counts and durations', async () => {
  const driver = new ScriptedDriver(async (_ctx, attempt) =>
    attempt === 1 ? { status: 'succeeded', finalText: 'ok' } : { status: 'failed', finalText: '', error: 'x' },
  );
  const box = await makeBox(driver);
  await box.run(REQUEST);
  await box.run({ ...REQUEST, session: { userId: 'u2', goalId: 'g' } });
  const stats = box.stats;
  assert.equal(stats.totalRuns, 2);
  assert.equal(stats.byStatus.succeeded, 1);
  assert.equal(stats.byStatus.failed, 1);
  assert.ok(stats.avgDurationMs >= 0);
  await box.close();
});
