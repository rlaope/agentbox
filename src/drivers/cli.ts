import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type { AgentBackend, AgentDriver, CommandSpec, DriverContext, DriverOutcome, RunEvent } from '../types.js';

export type CliInvocation = CommandSpec;

/** Parse state for a single run. Driver instances are shared and stateless. */
export interface CliParseState {
  finalText: string;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** Environment allowlist for child processes, shrinking the secret-leak surface between sessions. */
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  // USER/LOGNAME are required for macOS Keychain credential lookup
  // (claude CLI subscription auth fails with "Not logged in" without USER).
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_HOME',
];

/**
 * Shared runner for CLI-based agent backends. Spawns the CLI with the
 * workspace pinned as cwd, parses stdout line by line into RunEvents,
 * and handles timeout/cancellation.
 */
export abstract class CliDriver implements AgentDriver {
  abstract readonly backend: AgentBackend;

  protected abstract invocation(ctx: DriverContext): CliInvocation;

  protected abstract onLine(
    line: string,
    parse: CliParseState,
    ctx: DriverContext,
    emit: (event: RunEvent) => void,
  ): void;

  /** Async setup before the invocation is built (e.g. writing config files). */
  protected async beforeRun(_ctx: DriverContext): Promise<void> {}

  async run(ctx: DriverContext, emit: (event: RunEvent) => void): Promise<DriverOutcome> {
    await this.beforeRun(ctx);
    const base = this.invocation(ctx);
    // Harness-scoped env vars ride on the invocation so the sandbox can
    // forward them across its boundary (docker -e NAME for containers).
    const harnessEnv: Record<string, string> = {};
    for (const name of ctx.harness.env ?? []) {
      const value = process.env[name];
      if (value !== undefined) harnessEnv[name] = value;
    }
    // The sandbox decides how the command crosses its boundary
    // (identity for local, `docker run ...` for containers).
    const inv = ctx.sandbox.wrapCommand({ ...base, env: { ...harnessEnv, ...base.env } });
    const timeoutMs = ctx.harness.limits?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return await new Promise<DriverOutcome>((resolve) => {
      const child = spawn(inv.command, inv.args, {
        cwd: ctx.sandbox.root,
        env: this.childEnv(inv.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const parse: CliParseState = { finalText: '' };
      let timedOut = false;
      let cancelled = false;
      let settled = false;

      const settle = (outcome: DriverOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        resolve(outcome);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      const onAbort = () => {
        cancelled = true;
        child.kill('SIGKILL');
      };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });

      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        try {
          this.onLine(line, parse, ctx, emit);
        } catch {
          // Ignore unparseable lines to stay resilient to backend output format changes.
        }
      });

      let stderrTail = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-4000);
      });

      child.on('error', (err) => {
        settle({ status: 'failed', finalText: parse.finalText, error: `spawn ${inv.command}: ${err.message}` });
      });

      child.on('close', (code) => {
        if (timedOut) {
          settle({ status: 'timeout', finalText: parse.finalText, error: `run exceeded ${timeoutMs}ms` });
        } else if (cancelled) {
          settle({ status: 'cancelled', finalText: parse.finalText });
        } else if (parse.error) {
          settle({ status: 'failed', finalText: parse.finalText, error: parse.error });
        } else if (code !== 0) {
          settle({ status: 'failed', finalText: parse.finalText, error: `exit ${code}: ${stderrTail.trim()}` });
        } else {
          settle({ status: 'succeeded', finalText: parse.finalText });
        }
      });
    });
  }

  protected childEnv(extra?: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of ENV_ALLOWLIST) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    return { ...env, ...extra };
  }
}
