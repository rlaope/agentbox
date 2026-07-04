import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agentbox, ClaudeDriver } from '../src/index.js';
import type { CliParseState, DriverContext, RunEvent } from '../src/index.js';

/**
 * Tool-surface A/B benchmark with a REAL agent CLI (claude).
 * Same task, two conditions:
 *   minimal — exactly the tools the task needs (Read, Write)
 *   full    — a broad general-purpose surface (Bash, Glob, Grep, web, …)
 * Measures turns, tool calls, tokens, cost, and wall time per run.
 *
 *   npx tsx bench/tool-surface-ab.mts
 */

interface RunStats {
  turns?: number;
  costUsd?: number;
  outputTokens?: number;
  inputTokens?: number;
}

/** ClaudeDriver that also captures usage stats from the result message. */
class MeasuringClaudeDriver extends ClaudeDriver {
  readonly statsByRun = new Map<string, RunStats>();

  protected override onLine(line: string, parse: CliParseState, ctx: DriverContext, emit: (e: RunEvent) => void): void {
    super.onLine(line, parse, ctx, emit);
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    try {
      const msg = JSON.parse(trimmed) as Record<string, any>;
      if (msg.type === 'result') {
        this.statsByRun.set(ctx.runId, {
          turns: msg.num_turns,
          costUsd: msg.total_cost_usd,
          outputTokens: msg.usage?.output_tokens,
          inputTokens: msg.usage?.input_tokens,
        });
      }
    } catch {
      // ignore
    }
  }
}

const MINIMAL_TOOLS = ['Read', 'Write'];
const FULL_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'TodoWrite'];
const TASK =
  'Read a.txt and b.txt, then write summary.md containing the total revenue across all quarters. Do only that.';
const RUNS = 3;

const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-tool-ab-'));

async function runCondition(label: string, tools: string[]): Promise<RunStats[]> {
  const driver = new MeasuringClaudeDriver();
  const box = new Agentbox({ baseDir: path.join(baseDir, label), drivers: { claude: driver } });
  box.register({
    name: 'summarize',
    backend: 'claude',
    systemPrompt: 'Do exactly what is asked inside the workspace, then stop.',
    tools: { allow: tools },
    limits: { maxTurns: 20, timeoutMs: 180_000 },
  });
  const out: RunStats[] = [];
  for (let i = 0; i < RUNS; i++) {
    const goalId = `run-${i}`;
    // Each run gets a fresh session/workspace so nothing carries over.
    const [id] = await box.prewarmSessions([{ userId: 'bench', goalId }]);
    const dir = path.join(baseDir, label, 'sessions', id);
    await fs.writeFile(path.join(dir, 'a.txt'), 'revenue Q1: 100, Q2: 140\n');
    await fs.writeFile(path.join(dir, 'b.txt'), 'revenue Q3: 155, Q4: 210\n');
    process.stdout.write(`  ${label} run ${i + 1}/${RUNS}... `);
    const result = await box.run({ session: { userId: 'bench', goalId }, harness: 'summarize', prompt: TASK });
    const stats = driver.statsByRun.get(result.runId) ?? {};
    console.log(`turns=${stats.turns} ${Math.round(result.durationMs / 1000)}s $${(stats.costUsd ?? 0).toFixed(3)} ${result.status}`);
    out.push({ ...stats });
  }
  await box.close();
  return out;
}

const avg = (ns: number[]) => ns.reduce((a, b) => a + b, 0) / ns.length;
const summarize = (label: string, r: RunStats[]) => ({
  condition: label,
  avgTurns: +avg(r.map((x) => x.turns ?? 0)).toFixed(2),
  avgCostUsd: +avg(r.map((x) => x.costUsd ?? 0)).toFixed(4),
  avgOutputTokens: Math.round(avg(r.map((x) => x.outputTokens ?? 0))),
});

console.log(`tool-surface A/B — claude CLI via the framework, ${RUNS} runs each\n`);
console.log(`MINIMAL (${MINIMAL_TOOLS.length}): ${MINIMAL_TOOLS.join(', ')}`);
const minimal = await runCondition('minimal', MINIMAL_TOOLS);
console.log(`\nFULL (${FULL_TOOLS.length}): ${FULL_TOOLS.join(', ')}`);
const full = await runCondition('full', FULL_TOOLS);

console.log('\n=== RESULTS ===');
console.table([summarize('minimal', minimal), summarize('full', full)]);
await fs.rm(baseDir, { recursive: true, force: true });