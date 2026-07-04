import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Agentbox } from '../src/agentbox.js';
import { renderPrometheus } from '../src/metrics/prometheus.js';
import { createHttpServer } from '../src/server/http.js';
import type { AgentDriver, DriverContext, DriverOutcome } from '../src/types.js';

class OkDriver implements AgentDriver {
  readonly backend = 'claude' as const;
  async run(_ctx: DriverContext): Promise<DriverOutcome> {
    return { status: 'succeeded', finalText: 'ok' };
  }
}

test('renderPrometheus emits valid gauges and per-status counters', () => {
  const text = renderPrometheus({
    sessions: 3,
    runningRuns: 1,
    queuedRuns: 2,
    activeRuns: 1,
    totalRuns: 10,
    byStatus: { succeeded: 8, failed: 2 },
    avgDurationMs: 1234,
  });
  assert.match(text, /# TYPE agentbox_sessions gauge/);
  assert.match(text, /agentbox_sessions 3/);
  assert.match(text, /agentbox_runs_total\{status="succeeded"\} 8/);
  assert.match(text, /agentbox_runs_total\{status="failed"\} 2/);
  assert.match(text, /agentbox_runs_total\{status="cancelled"\} 0/);
  assert.match(text, /agentbox_run_duration_ms_avg 1234/);
  assert.ok(text.endsWith('\n'));
});

test('GET /metrics is scrapable without auth and reflects run activity', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-metrics-'));
  const box = new Agentbox({ baseDir, drivers: { claude: new OkDriver() } });
  box.register({ name: 'task', backend: 'claude' });
  // Auth is configured, but /metrics must still be reachable.
  const server = createHttpServer(box, { apiKeys: ['secret'] });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await box.run({ session: { userId: 'u', goalId: 'g' }, harness: 'task', prompt: 'x' });

  const res = await fetch(`${base}/metrics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
  const body = await res.text();
  assert.match(body, /agentbox_runs_finished_total 1/);
  assert.match(body, /agentbox_runs_total\{status="succeeded"\} 1/);

  await new Promise((r) => server.close(r));
  await box.close();
});
