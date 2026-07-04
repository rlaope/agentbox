import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Agentbox, type AgentboxOptions } from '../src/agentbox.js';
import { denyOutputPatterns, runGuardrails } from '../src/guardrails/engine.js';
import type {
  AgentDriver,
  DriverContext,
  DriverOutcome,
  Guardrail,
  HarnessSpec,
  RunEvent,
} from '../src/types.js';

// A driver double that records whether it was ever invoked, and returns a
// caller-supplied final text so output guardrails have something to inspect.
class RecordingDriver implements AgentDriver {
  readonly backend = 'claude' as const;
  ran = false;
  attempts = 0;

  constructor(private readonly finalText = 'ok', private readonly onRun?: (ctx: DriverContext) => Promise<void>) {}

  async run(ctx: DriverContext): Promise<DriverOutcome> {
    this.ran = true;
    this.attempts++;
    if (this.onRun) await this.onRun(ctx);
    return { status: 'succeeded', finalText: this.finalText };
  }
}

async function makeBox(
  driver: AgentDriver,
  harness: Partial<HarnessSpec> = {},
  opts: Partial<AgentboxOptions> = {},
) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-guardrails-'));
  const box = new Agentbox({ baseDir, drivers: { claude: driver }, ...opts });
  box.register({ name: 'task', backend: 'claude', ...harness });
  return box;
}

const REQUEST = { session: { userId: 'u1', goalId: 'g' }, harness: 'task', prompt: 'do the thing' };

const allow: Guardrail = () => ({ allowed: true });
const block =
  (reason: string): Guardrail =>
  () => ({ allowed: false, reason });

// --- input guardrails --------------------------------------------------------

test('input guardrail block prevents the run and never spawns the driver', async () => {
  const driver = new RecordingDriver();
  const box = await makeBox(driver, { guardrails: { input: [block('no dice')] } });
  const events: RunEvent[] = [];

  const result = await box.run(REQUEST, (e) => events.push(e));

  assert.equal(result.status, 'blocked');
  assert.equal(driver.ran, false, 'driver must not run when input is blocked');
  assert.equal(driver.attempts, 0);
  assert.ok(result.guardrail, 'guardrail metadata must be present');
  assert.equal(result.guardrail?.stage, 'input');
  assert.equal(result.guardrail?.reason, 'no dice');
  assert.equal(result.error, 'no dice');
  // A blocked run is a terminal error, not a success.
  assert.ok(events.some((e) => e.type === 'run:error'));
  assert.ok(!events.some((e) => e.type === 'run:done'));
  await box.close();
});

test('allowing input guardrail lets the run proceed normally', async () => {
  const driver = new RecordingDriver('all good');
  const box = await makeBox(driver, { guardrails: { input: [allow, allow] } });

  const result = await box.run(REQUEST);

  assert.equal(result.status, 'succeeded');
  assert.equal(driver.ran, true);
  assert.equal(result.finalText, 'all good');
  assert.equal(result.guardrail, undefined);
  await box.close();
});

test('first blocking input guardrail short-circuits the rest', async () => {
  const driver = new RecordingDriver();
  let secondRan = false;
  const second: Guardrail = () => {
    secondRan = true;
    return { allowed: true };
  };
  const box = await makeBox(driver, { guardrails: { input: [block('stop'), second] } });

  const result = await box.run(REQUEST);

  assert.equal(result.status, 'blocked');
  assert.equal(secondRan, false, 'guardrails after a block should not run');
  assert.equal(driver.ran, false);
  await box.close();
});

// --- output guardrails -------------------------------------------------------

test('output guardrail block on finalText marks the run blocked', async () => {
  const driver = new RecordingDriver('here is a SECRET token');
  const sawSecret: Guardrail = (ctx) =>
    /SECRET/.test(ctx.finalText ?? '') ? { allowed: false, reason: 'leaked secret' } : { allowed: true };
  const box = await makeBox(driver, { guardrails: { output: [sawSecret] } });

  const result = await box.run(REQUEST);

  assert.equal(result.status, 'blocked');
  assert.equal(driver.ran, true, 'output guardrails run after the driver produced a result');
  assert.equal(result.guardrail?.stage, 'output');
  assert.equal(result.guardrail?.reason, 'leaked secret');
  await box.close();
});

test('output guardrail sees finalText (and no finalText leaks into input stage)', async () => {
  const driver = new RecordingDriver('final output body');
  let inputFinalText: string | undefined = 'sentinel';
  let outputFinalText: string | undefined;
  const captureInput: Guardrail = (ctx) => {
    inputFinalText = ctx.finalText;
    return { allowed: true };
  };
  const captureOutput: Guardrail = (ctx) => {
    outputFinalText = ctx.finalText;
    return { allowed: true };
  };
  const box = await makeBox(driver, {
    guardrails: { input: [captureInput], output: [captureOutput] },
  });

  const result = await box.run(REQUEST);

  assert.equal(result.status, 'succeeded');
  assert.equal(inputFinalText, undefined, 'input stage must not receive finalText');
  assert.equal(outputFinalText, 'final output body');
  await box.close();
});

test('allowing output guardrail lets a successful run through unblocked', async () => {
  const driver = new RecordingDriver('clean output');
  const box = await makeBox(driver, { guardrails: { output: [allow] } });

  const result = await box.run(REQUEST);

  assert.equal(result.status, 'succeeded');
  assert.equal(result.guardrail, undefined);
  assert.equal(result.finalText, 'clean output');
  await box.close();
});

// --- fail-closed on throw ----------------------------------------------------

test('a throwing input guardrail fails closed (blocks the run)', async () => {
  const driver = new RecordingDriver();
  const boom: Guardrail = () => {
    throw new Error('guardrail exploded');
  };
  const box = await makeBox(driver, { guardrails: { input: [boom] } });

  const result = await box.run(REQUEST);

  assert.equal(result.status, 'blocked', 'a throwing guardrail must not wave content through');
  assert.equal(driver.ran, false);
  assert.equal(result.guardrail?.stage, 'input');
  assert.match(result.guardrail?.reason ?? '', /threw/);
  assert.match(result.guardrail?.reason ?? '', /guardrail exploded/);
  await box.close();
});

test('a throwing output guardrail fails closed (blocks the finished run)', async () => {
  const driver = new RecordingDriver('some output');
  const boom: Guardrail = () => {
    throw new Error('output check exploded');
  };
  const box = await makeBox(driver, { guardrails: { output: [boom] } });

  const result = await box.run(REQUEST);

  assert.equal(result.status, 'blocked');
  assert.equal(result.guardrail?.stage, 'output');
  assert.match(result.guardrail?.reason ?? '', /threw/);
  await box.close();
});

// --- built-in denyOutputPatterns --------------------------------------------

test('denyOutputPatterns blocks when a pattern matches the output', async () => {
  const driver = new RecordingDriver('AWS key AKIA1234567890 embedded');
  const box = await makeBox(driver, {
    guardrails: { output: [denyOutputPatterns([/AKIA[0-9A-Z]{6,}/])] },
  });

  const result = await box.run(REQUEST);

  assert.equal(result.status, 'blocked');
  assert.equal(result.guardrail?.stage, 'output');
  assert.match(result.guardrail?.reason ?? '', /blocked pattern/);
  await box.close();
});

test('denyOutputPatterns allows output that matches nothing', async () => {
  const driver = new RecordingDriver('perfectly benign text');
  const box = await makeBox(driver, {
    guardrails: { output: [denyOutputPatterns([/AKIA[0-9A-Z]{6,}/, /-----BEGIN/])] },
  });

  const result = await box.run(REQUEST);

  assert.equal(result.status, 'succeeded');
  assert.equal(result.guardrail, undefined);
  await box.close();
});

// --- engine unit-level checks ------------------------------------------------

test('runGuardrails returns allow for an empty / undefined guard list', async () => {
  const ctx = { session: REQUEST.session, harness: 'task', prompt: 'p' };
  assert.deepEqual(await runGuardrails(undefined, ctx), { allowed: true });
  assert.deepEqual(await runGuardrails([], ctx), { allowed: true });
});

test('runGuardrails runs guards in order and returns the first block', async () => {
  const seen: string[] = [];
  const g = (name: string, allowed: boolean): Guardrail => (ctx) => {
    seen.push(name);
    void ctx;
    return allowed ? { allowed: true } : { allowed: false, reason: name };
  };
  const verdict = await runGuardrails(
    [g('a', true), g('b', false), g('c', true)],
    { session: REQUEST.session, harness: 'task', prompt: 'p' },
  );
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'b');
  assert.deepEqual(seen, ['a', 'b'], 'c must not run after b blocks');
});

test('runGuardrails treats an async-rejecting guard as a block', async () => {
  const rejecting: Guardrail = async () => {
    throw new Error('async boom');
  };
  const verdict = await runGuardrails([rejecting], {
    session: REQUEST.session,
    harness: 'task',
    prompt: 'p',
  });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason ?? '', /async boom/);
});
