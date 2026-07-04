import type { AgentboxStats } from '../agentbox.js';

/**
 * Renders AgentboxStats as Prometheus text-format exposition, so any
 * Prometheus/OpenTelemetry-collector scrape target can ingest agentbox
 * metrics without pulling an SDK into the framework. Wire it to a
 * `GET /metrics` endpoint.
 */
export function renderPrometheus(stats: AgentboxStats): string {
  const lines: string[] = [];
  const gauge = (name: string, help: string, value: number, labels = '') => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name}${labels} ${value}`);
  };

  gauge('agentbox_sessions', 'Active sessions', stats.sessions);
  gauge('agentbox_runs_running', 'Runs currently executing', stats.runningRuns);
  gauge('agentbox_runs_queued', 'Runs waiting in the scheduler queue', stats.queuedRuns);
  gauge('agentbox_runs_active', 'Runs started but not yet finished', stats.activeRuns);
  gauge('agentbox_run_duration_ms_avg', 'Average finished-run duration in ms', stats.avgDurationMs);

  lines.push('# HELP agentbox_runs_total Finished runs by terminal status');
  lines.push('# TYPE agentbox_runs_total counter');
  const statuses: Array<keyof AgentboxStats['byStatus']> = ['succeeded', 'failed', 'cancelled', 'timeout'];
  for (const status of statuses) {
    lines.push(`agentbox_runs_total{status="${status}"} ${stats.byStatus[status] ?? 0}`);
  }
  lines.push('# HELP agentbox_runs_finished_total All finished runs');
  lines.push('# TYPE agentbox_runs_finished_total counter');
  lines.push(`agentbox_runs_finished_total ${stats.totalRuns}`);

  return lines.join('\n') + '\n';
}
