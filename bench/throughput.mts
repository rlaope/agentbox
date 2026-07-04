import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agentbox } from '../src/index.js';
import type { AgentDriver, DriverContext, DriverOutcome } from '../src/index.js';

/**
 * Framework-overhead benchmark. Drivers are simulated (setTimeout), so the
 * numbers measure agentbox itself — scheduling, session management, state
 * persistence, artifact collection — not LLM/agent latency.
 *
 *   npx tsx bench/throughput.mts
 */

class SimulatedDriver implements AgentDriver {
  readonly backend = 'claude' as const;
  constructor(private readonly latencyMs: number) {}

  async run(ctx: DriverContext): Promise<DriverOutcome> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    await ctx.sandbox.writeFile('out/result.txt', `done ${ctx.runId}`);
    return { status: 'succeeded', finalText: 'done' };
  }
}

interface Scenario {
  name: string;
  driverLatencyMs: number;
  users: number;
  sessionsPerUser: number;
  runsPerSession: number;
  maxConcurrentRuns: number;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function runScenario(s: Scenario): Promise<void> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-bench-'));
  const box = new Agentbox({
    baseDir,
    maxConcurrentRuns: s.maxConcurrentRuns,
    drivers: { claude: new SimulatedDriver(s.driverLatencyMs) },
  });
  box.register({ name: 'bench', backend: 'claude', artifacts: { globs: ['out/**'] } });

  const requests: Array<Promise<{ durationMs: number; status: string }>> = [];
  const started = performance.now();
  for (let u = 0; u < s.users; u++) {
    for (let g = 0; g < s.sessionsPerUser; g++) {
      for (let r = 0; r < s.runsPerSession; r++) {
        requests.push(
          box
            .run({ session: { userId: `u${u}`, goalId: `g${g}` }, harness: 'bench', prompt: 'x' })
            .then((res) => ({ durationMs: res.durationMs, status: res.status })),
        );
      }
    }
  }
  const results = await Promise.all(requests);
  const wallMs = performance.now() - started;

  const failed = results.filter((r) => r.status !== 'succeeded').length;
  const overheads = results.map((r) => r.durationMs - s.driverLatencyMs).sort((a, b) => a - b);
  const total = results.length;

  console.log(`\n## ${s.name}`);
  console.log(
    `runs=${total} users=${s.users} sessions=${s.users * s.sessionsPerUser} ` +
      `concurrency=${s.maxConcurrentRuns} driverLatency=${s.driverLatencyMs}ms`,
  );
  console.log(`wall=${(wallMs / 1000).toFixed(2)}s throughput=${(total / (wallMs / 1000)).toFixed(1)} runs/s failed=${failed}`);
  console.log(
    `per-run framework overhead (incl. queue wait): ` +
      `p50=${percentile(overheads, 50)}ms p95=${percentile(overheads, 95)}ms max=${overheads[overheads.length - 1]}ms`,
  );
  await box.close();
  await fs.rm(baseDir, { recursive: true, force: true });
}

console.log(`agentbox throughput benchmark — node ${process.version}, ${os.cpus()[0]?.model ?? 'unknown cpu'}`);

await runScenario({
  name: 'pure overhead (0ms driver)',
  driverLatencyMs: 0,
  users: 10,
  sessionsPerUser: 2,
  runsPerSession: 10,
  maxConcurrentRuns: 8,
});

await runScenario({
  name: 'simulated agent (300ms driver)',
  driverLatencyMs: 300,
  users: 20,
  sessionsPerUser: 2,
  runsPerSession: 5,
  maxConcurrentRuns: 16,
});

await runScenario({
  name: 'burst fairness (300ms driver, 1 heavy user + 9 light)',
  driverLatencyMs: 300,
  users: 10,
  sessionsPerUser: 1,
  runsPerSession: 10,
  maxConcurrentRuns: 8,
});
