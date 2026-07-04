import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ClaudeDriver } from './drivers/claude.js';
import { CodexDriver } from './drivers/codex.js';
import { PiDriver } from './drivers/pi.js';
import { HarnessRegistry } from './harness/registry.js';
import { LocalSandboxProvider } from './sandbox/local.js';
import { FairScheduler } from './scheduler/scheduler.js';
import { SessionManager } from './session/manager.js';
import type {
  AgentBackend,
  AgentDriver,
  HarnessSpec,
  RunEvent,
  RunRequest,
  RunResult,
  SandboxKind,
  SandboxProvider,
} from './types.js';

export interface AgentboxOptions {
  /** 세션 워크스페이스가 놓일 루트. 기본값 ./.agentbox */
  baseDir?: string;
  /** 서버 전체 동시 run 상한. 기본값 4 */
  maxConcurrentRuns?: number;
  session?: {
    idleTtlMs?: number;
    maxSessions?: number;
  };
  /** 백엔드별 드라이버 오버라이드 (테스트 더블, 커스텀 어댑터) */
  drivers?: Partial<Record<AgentBackend, AgentDriver>>;
  /** 격리 백엔드 추가/교체 (기본은 local 프로세스 샌드박스) */
  sandboxProviders?: SandboxProvider[];
}

/**
 * 프레임워크 진입점. 하네스 등록소 + 세션 매니저 + 공정 스케줄러 + 드라이버를
 * 묶어 "요청 → 세션 획득 → 하네스 실행 → 산출물 수집"의 한 사이클을 제공한다.
 */
export class Agentbox {
  private readonly registry = new HarnessRegistry();
  private readonly sessions: SessionManager;
  private readonly scheduler: FairScheduler;
  private readonly drivers: Map<AgentBackend, AgentDriver>;

  constructor(opts: AgentboxOptions = {}) {
    const baseDir = path.resolve(opts.baseDir ?? '.agentbox');
    const providers = new Map<SandboxKind, SandboxProvider>();
    providers.set('local', new LocalSandboxProvider(path.join(baseDir, 'sessions')));
    for (const provider of opts.sandboxProviders ?? []) {
      providers.set(provider.kind, provider);
    }
    this.sessions = new SessionManager(providers, {
      idleTtlMs: opts.session?.idleTtlMs ?? 30 * 60_000,
      maxSessions: opts.session?.maxSessions ?? 256,
    });
    this.scheduler = new FairScheduler(opts.maxConcurrentRuns ?? 4);
    this.drivers = new Map<AgentBackend, AgentDriver>([
      ['pi', new PiDriver()],
      ['codex', new CodexDriver()],
      ['claude', new ClaudeDriver()],
    ]);
    for (const [backend, driver] of Object.entries(opts.drivers ?? {})) {
      this.drivers.set(backend as AgentBackend, driver);
    }
  }

  register(spec: HarnessSpec): this {
    this.registry.register(spec);
    return this;
  }

  harnesses(): HarnessSpec[] {
    return this.registry.list();
  }

  async run(request: RunRequest, onEvent: (event: RunEvent) => void = () => {}): Promise<RunResult> {
    const harness = this.registry.get(request.harness);
    const driver = this.drivers.get(harness.backend);
    if (!driver) throw new Error(`no driver registered for backend "${harness.backend}"`);

    const runId = randomUUID();
    const startedAt = Date.now();
    const session = await this.sessions.acquire(request.session, harness.sandbox ?? 'local', harness.workspace);
    const abort = new AbortController();
    onEvent({ type: 'run:start', runId, sessionId: session.id, harness: harness.name });

    const outcome = await this.scheduler.schedule(request.session.userId, () =>
      session.runExclusive(() =>
        driver.run(
          {
            runId,
            harness,
            prompt: request.prompt,
            sandbox: session.sandbox,
            state: session.stateFor(harness.backend),
            signal: abort.signal,
          },
          onEvent,
        ),
      ),
    );

    const artifacts = harness.artifacts?.globs?.length
      ? await session.sandbox.collect(harness.artifacts.globs)
      : [];

    const result: RunResult = {
      runId,
      status: outcome.status,
      finalText: outcome.finalText,
      artifacts,
      durationMs: Date.now() - startedAt,
      error: outcome.error,
    };
    if (outcome.status === 'succeeded') {
      onEvent({ type: 'run:done', result });
    } else {
      onEvent({ type: 'run:error', error: outcome.error ?? outcome.status, result });
    }
    return result;
  }

  get stats(): { sessions: number; runningRuns: number; queuedRuns: number } {
    return {
      sessions: this.sessions.size,
      runningRuns: this.scheduler.runningCount,
      queuedRuns: this.scheduler.pendingCount,
    };
  }

  async close(): Promise<void> {
    await this.sessions.close();
  }
}
