import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type { AgentBackend, AgentDriver, DriverContext, DriverOutcome, RunEvent } from '../types.js';

export interface CliInvocation {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** run 1회 동안의 파싱 상태. 드라이버 인스턴스는 stateless로 공유된다. */
export interface CliParseState {
  finalText: string;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** 자식 프로세스로 전달할 환경변수 allowlist. 세션 간 비밀 누출 표면을 줄인다. */
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_HOME',
];

/**
 * CLI 기반 agent 백엔드 공통 실행기. 워크스페이스를 cwd로 고정해 spawn하고
 * stdout을 라인 단위로 파싱해 RunEvent로 변환하며 timeout/cancel을 처리한다.
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

  async run(ctx: DriverContext, emit: (event: RunEvent) => void): Promise<DriverOutcome> {
    const inv = this.invocation(ctx);
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
          // 파싱 불가 라인은 무시한다 (백엔드 출력 포맷 변화에 견디기 위함)
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
