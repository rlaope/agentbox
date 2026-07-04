import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Agentbox } from '../src/agentbox.js';
import { denyOutputPatterns } from '../src/guardrails/engine.js';
import type { AgentDriver, ArtifactStore, DriverContext, DriverOutcome } from '../src/types.js';

/** Regression tests for defects found by the adversarial review. */

test('denyOutputPatterns with a /g pattern blocks consistently across runs (no fail-open)', async () => {
  const guard = denyOutputPatterns([/AKIA[0-9A-Z]{6,}/g]);
  const ctx = { session: { userId: 'u', goalId: 'g' }, harness: 'h', prompt: '', finalText: 'key AKIA1234ABCD here' };
  // A /g regex mutates lastIndex; a reused guardrail must not alternate.
  assert.equal((await guard(ctx)).allowed, false);
  assert.equal((await guard(ctx)).allowed, false);
  assert.equal((await guard(ctx)).allowed, false);
});

class LeakDriver implements AgentDriver {
  readonly backend = 'claude' as const;
  async run(ctx: DriverContext): Promise<DriverOutcome> {
    await ctx.sandbox.writeFile('out/secret.txt', 'AKIA1234ABCD');
    return { status: 'succeeded', finalText: 'wrote AKIA1234ABCD' };
  }
}

test('an output guardrail blocks BEFORE the artifact store upload', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-guard-order-'));
  let uploads = 0;
  const store: ArtifactStore = {
    store: async (_runId, artifacts) => {
      uploads++;
      return artifacts;
    },
  };
  const box = new Agentbox({ baseDir, drivers: { claude: new LeakDriver() }, artifactStore: store });
  box.register({
    name: 'leaky',
    backend: 'claude',
    artifacts: { globs: ['out/**'] },
    guardrails: { output: [denyOutputPatterns([/AKIA[0-9A-Z]{6,}/])] },
  });

  const result = await box.run({ session: { userId: 'u', goalId: 'g' }, harness: 'leaky', prompt: 'x' });
  assert.equal(result.status, 'blocked');
  assert.equal(result.guardrail?.stage, 'output');
  // The flagged content must never have been persisted to durable storage.
  assert.equal(uploads, 0);
  await box.close();
});
