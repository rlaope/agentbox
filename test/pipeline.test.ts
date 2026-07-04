import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Agentbox } from '../src/agentbox.js';
import type {
  AgentDriver,
  DriverContext,
  DriverOutcome,
  Guardrail,
  HarnessSpec,
  RunEvent,
} from '../src/types.js';

/**
 * A driver double that dispatches by harness name. Every harness in these
 * tests uses backend 'claude', so a single injected driver handles the whole
 * pipeline; the handler map decides what each step does. Handlers get the live
 * DriverContext, so they can writeFile / read the shared workspace.
 */
class DispatchDriver implements AgentDriver {
  readonly backend = 'claude' as const;
  /** harness name -> number of times its handler ran (proves non-run steps). */
  readonly calls = new Map<string, number>();

  constructor(
    private readonly handlers: Record<string, (ctx: DriverContext) => Promise<DriverOutcome>>,
  ) {}

  async run(ctx: DriverContext): Promise<DriverOutcome> {
    const name = ctx.harness.name;
    this.calls.set(name, (this.calls.get(name) ?? 0) + 1);
    const handler = this.handlers[name];
    if (!handler) throw new Error(`no handler for harness "${name}"`);
    return handler(ctx);
  }
}

/** Reads a workspace file directly via the sandbox root (Sandbox has no read API). */
async function readWorkspace(ctx: DriverContext, rel: string): Promise<string> {
  return fs.readFile(path.join(ctx.sandbox.root, rel), 'utf8');
}

async function makeBox(
  driver: AgentDriver,
  harnesses: HarnessSpec[],
): Promise<Agentbox> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-pipeline-'));
  const box = new Agentbox({ baseDir, drivers: { claude: driver } });
  for (const h of harnesses) box.register(h);
  return box;
}

const SESSION = { userId: 'u1', goalId: 'pipeline-goal' };

// --- shared session / shared workspace --------------------------------------

test('all steps run in one session sharing a workspace', async () => {
  const driver = new DispatchDriver({
    // Step 1 writes a file into the shared workspace.
    writer: async (ctx) => {
      await ctx.sandbox.writeFile('shared.txt', 'hello-from-step-1');
      return { status: 'succeeded', finalText: 'wrote shared.txt' };
    },
    // Step 2 reads the file step 1 wrote, proving one shared workspace.
    reader: async (ctx) => {
      const seen = await readWorkspace(ctx, 'shared.txt');
      return { status: 'succeeded', finalText: `read:${seen}` };
    },
  });
  const box = await makeBox(driver, [
    { name: 'writer', backend: 'claude' },
    { name: 'reader', backend: 'claude' },
  ]);

  const result = await box.runPipeline(SESSION, [
    { harness: 'writer', prompt: 'write it' },
    { harness: 'reader', prompt: 'read it' },
  ]);

  assert.equal(result.status, 'succeeded');
  assert.equal(result.steps.length, 2);

  // Shared workspace: step 2 saw step 1's file.
  assert.equal(result.steps[1].finalText, 'read:hello-from-step-1');

  // Same session: identical sessionId across every step result...
  const ids = new Set(result.steps.map((s) => s.sessionId));
  assert.equal(ids.size, 1);
  // ...and it is the deterministic id for this SessionKey.
  assert.equal(result.steps[0].sessionId, result.steps[1].sessionId);

  // Every step carries the same SessionKey it was launched with.
  for (const s of result.steps) {
    assert.deepEqual(s.session, SESSION);
  }
  await box.close();
});

test('steps run in declared order and each gets its own RunResult', async () => {
  const order: string[] = [];
  const mk = (label: string) => async (): Promise<DriverOutcome> => {
    order.push(label);
    return { status: 'succeeded', finalText: label };
  };
  const driver = new DispatchDriver({ a: mk('a'), b: mk('b'), c: mk('c') });
  const box = await makeBox(driver, [
    { name: 'a', backend: 'claude' },
    { name: 'b', backend: 'claude' },
    { name: 'c', backend: 'claude' },
  ]);

  const result = await box.runPipeline(SESSION, [
    { harness: 'a', prompt: '1' },
    { harness: 'b', prompt: '2' },
    { harness: 'c', prompt: '3' },
  ]);

  assert.equal(result.status, 'succeeded');
  // One RunResult per step, in order.
  assert.deepEqual(result.steps.map((s) => s.harness), ['a', 'b', 'c']);
  assert.deepEqual(result.steps.map((s) => s.finalText), ['a', 'b', 'c']);
  assert.ok(result.steps.every((s) => s.status === 'succeeded'));
  // Handlers actually executed in pipeline order.
  assert.deepEqual(order, ['a', 'b', 'c']);
  await box.close();
});

test('a three-step pipeline accumulates workspace state across every step', async () => {
  const driver = new DispatchDriver({
    step1: async (ctx) => {
      await ctx.sandbox.writeFile('log.txt', 'a');
      return { status: 'succeeded', finalText: 's1' };
    },
    step2: async (ctx) => {
      const prev = await readWorkspace(ctx, 'log.txt');
      await ctx.sandbox.writeFile('log.txt', prev + 'b');
      return { status: 'succeeded', finalText: 's2' };
    },
    step3: async (ctx) => {
      const seen = await readWorkspace(ctx, 'log.txt');
      return { status: 'succeeded', finalText: `final:${seen}` };
    },
  });
  const box = await makeBox(driver, [
    { name: 'step1', backend: 'claude' },
    { name: 'step2', backend: 'claude' },
    { name: 'step3', backend: 'claude' },
  ]);

  const result = await box.runPipeline(SESSION, [
    { harness: 'step1', prompt: 'x' },
    { harness: 'step2', prompt: 'x' },
    { harness: 'step3', prompt: 'x' },
  ]);

  assert.equal(result.status, 'succeeded');
  // step3 observed both prior writes: proves one persistent shared workspace.
  assert.equal(result.steps[2].finalText, 'final:ab');
  await box.close();
});

// --- stop-at-first-non-succeeded --------------------------------------------

test('a failing middle step stops the pipeline and marks it failed', async () => {
  const driver = new DispatchDriver({
    first: async () => ({ status: 'succeeded', finalText: 'ok' }),
    middle: async () => ({ status: 'failed', finalText: '', error: 'boom' }),
    last: async () => ({ status: 'succeeded', finalText: 'never' }),
  });
  const box = await makeBox(driver, [
    { name: 'first', backend: 'claude' },
    { name: 'middle', backend: 'claude' },
    { name: 'last', backend: 'claude' },
  ]);

  const result = await box.runPipeline(SESSION, [
    { harness: 'first', prompt: '1' },
    { harness: 'middle', prompt: '2' },
    { harness: 'last', prompt: '3' },
  ]);

  assert.equal(result.status, 'failed');
  // Only the first two steps ran; the failure is recorded.
  assert.equal(result.steps.length, 2);
  assert.deepEqual(result.steps.map((s) => s.harness), ['first', 'middle']);
  assert.equal(result.steps[1].status, 'failed');
  assert.equal(result.steps[1].error, 'boom');
  // The step after the failure was never dispatched.
  assert.equal(driver.calls.get('last'), undefined);
  await box.close();
});

test('a blocked middle step (guardrail) stops the pipeline and marks it blocked', async () => {
  const denyAll: Guardrail = () => ({ allowed: false, reason: 'nope' });
  const driver = new DispatchDriver({
    first: async () => ({ status: 'succeeded', finalText: 'ok' }),
    // gated never reaches its driver: an input guardrail blocks first.
    gated: async () => ({ status: 'succeeded', finalText: 'should-not-run' }),
    last: async () => ({ status: 'succeeded', finalText: 'never' }),
  });
  const box = await makeBox(driver, [
    { name: 'first', backend: 'claude' },
    { name: 'gated', backend: 'claude', guardrails: { input: [denyAll] } },
    { name: 'last', backend: 'claude' },
  ]);

  const result = await box.runPipeline(SESSION, [
    { harness: 'first', prompt: '1' },
    { harness: 'gated', prompt: '2' },
    { harness: 'last', prompt: '3' },
  ]);

  assert.equal(result.status, 'blocked');
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[1].status, 'blocked');
  assert.equal(result.steps[1].guardrail?.stage, 'input');
  // Blocked step's driver never ran; neither did the step after it.
  assert.equal(driver.calls.get('gated'), undefined);
  assert.equal(driver.calls.get('last'), undefined);
  await box.close();
});

test('a guardrail that throws fails closed (blocks) rather than waving content through', async () => {
  const throwing: Guardrail = () => {
    throw new Error('guardrail exploded');
  };
  const driver = new DispatchDriver({
    boom: async () => ({ status: 'succeeded', finalText: 'leaked' }),
  });
  const box = await makeBox(driver, [
    { name: 'boom', backend: 'claude', guardrails: { input: [throwing] } },
  ]);

  const result = await box.runPipeline(SESSION, [{ harness: 'boom', prompt: 'x' }]);

  assert.equal(result.status, 'blocked');
  assert.equal(result.steps[0].status, 'blocked');
  // Driver must not have been invoked — the throw blocked before dispatch.
  assert.equal(driver.calls.get('boom'), undefined);
  await box.close();
});

// --- cross-session isolation -------------------------------------------------

test('two pipelines under different sessions use separate workspaces', async () => {
  const seen: Record<string, string | null> = {};
  const driver = new DispatchDriver({
    isolate: async (ctx) => {
      const marker = path.join(ctx.sandbox.root, 'other.txt');
      let found: string | null = null;
      try {
        found = await fs.readFile(marker, 'utf8');
      } catch {
        found = null;
      }
      // Each session writes a file unique to its own workspace.
      await ctx.sandbox.writeFile('mine.txt', ctx.sandbox.root);
      seen[ctx.sandbox.root] = found;
      return { status: 'succeeded', finalText: ctx.sandbox.root };
    },
  });
  const box = await makeBox(driver, [{ name: 'isolate', backend: 'claude' }]);

  const a = await box.runPipeline({ userId: 'a', goalId: 'g' }, [
    { harness: 'isolate', prompt: 'x' },
  ]);
  const b = await box.runPipeline({ userId: 'b', goalId: 'g' }, [
    { harness: 'isolate', prompt: 'x' },
  ]);

  assert.equal(a.status, 'succeeded');
  assert.equal(b.status, 'succeeded');
  // Different sessions => different workspace roots => different sessionIds.
  assert.notEqual(a.steps[0].sessionId, b.steps[0].sessionId);
  assert.notEqual(a.steps[0].finalText, b.steps[0].finalText);
  await box.close();
});

// --- empty pipeline edge case ------------------------------------------------

test('an empty pipeline succeeds with no steps', async () => {
  const driver = new DispatchDriver({});
  const box = await makeBox(driver, [{ name: 'noop', backend: 'claude' }]);
  const result = await box.runPipeline(SESSION, []);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.steps.length, 0);
  assert.ok(result.pipelineId);
  await box.close();
});

// --- event stream forwarding -------------------------------------------------

test('pipeline forwards run events for every step to the onEvent sink', async () => {
  const driver = new DispatchDriver({
    e1: async () => ({ status: 'succeeded', finalText: '1' }),
    e2: async () => ({ status: 'succeeded', finalText: '2' }),
  });
  const box = await makeBox(driver, [
    { name: 'e1', backend: 'claude' },
    { name: 'e2', backend: 'claude' },
  ]);
  const starts: string[] = [];
  const result = await box.runPipeline(
    SESSION,
    [
      { harness: 'e1', prompt: 'x' },
      { harness: 'e2', prompt: 'x' },
    ],
    (event: RunEvent) => {
      if (event.type === 'run:start') starts.push(event.harness);
    },
  );
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(starts, ['e1', 'e2']);
  await box.close();
});
