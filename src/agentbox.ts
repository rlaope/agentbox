import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { ClaudeDriver } from './drivers/claude.js';
import { CodexDriver } from './drivers/codex.js';
import { PiDriver } from './drivers/pi.js';
import { listHarnessFiles, loadHarnessFile } from './harness/markdown.js';
import { HarnessRegistry } from './harness/registry.js';
import { PackManager, type PackInfo } from './packs/manager.js';
import { LocalSandboxProvider } from './sandbox/local.js';
import { FairScheduler, QueueFullError, QueueTimeoutError } from './scheduler/scheduler.js';
import { SessionManager } from './session/manager.js';
import type {
  AgentBackend,
  AgentDriver,
  DriverOutcome,
  HarnessSpec,
  RunEvent,
  RunRequest,
  RunResult,
  RunStatus,
  SandboxKind,
  SandboxProvider,
} from './types.js';

/**
 * Lifecycle hooks — middleware-style observation points. Hook failures are
 * swallowed: observability must never break a run.
 */
export interface AgentboxHooks {
  onRunStart?: (info: { runId: string; request: RunRequest; harness: HarnessSpec }) => void | Promise<void>;
  onEvent?: (runId: string, event: RunEvent) => void | Promise<void>;
  onRunEnd?: (result: RunResult, request: RunRequest) => void | Promise<void>;
}

export interface AgentboxStats {
  sessions: number;
  runningRuns: number;
  queuedRuns: number;
  activeRuns: number;
  totalRuns: number;
  byStatus: Partial<Record<RunStatus, number>>;
  avgDurationMs: number;
}

export interface AgentboxOptions {
  /** Root directory for session workspaces. Defaults to ./.agentbox */
  baseDir?: string;
  /** Server-wide cap on concurrent runs. Defaults to 4 */
  maxConcurrentRuns?: number;
  /** Cap on concurrently running runs per user. Unbounded by default. */
  maxConcurrentRunsPerUser?: number;
  /** Pending-queue cap; excess run() calls fail fast. Unbounded by default. */
  maxQueuedRuns?: number;
  /** Fail runs that wait longer than this in the queue. */
  queueTimeoutMs?: number;
  session?: {
    idleTtlMs?: number;
    maxSessions?: number;
  };
  hooks?: AgentboxHooks;
  /** Per-backend driver overrides (test doubles, custom adapters) */
  drivers?: Partial<Record<AgentBackend, AgentDriver>>;
  /** Additional/replacement isolation backends (default is the local process sandbox) */
  sandboxProviders?: SandboxProvider[];
}

/**
 * Framework entry point. Ties the harness registry, session manager, fair
 * scheduler, and drivers into one cycle:
 * request → acquire session → run harness → collect artifacts.
 */
export class Agentbox {
  private readonly registry = new HarnessRegistry();
  private readonly baseDir: string;
  private readonly sessions: SessionManager;
  private readonly scheduler: FairScheduler;
  private readonly drivers: Map<AgentBackend, AgentDriver>;
  private readonly watchers: FSWatcher[] = [];
  /** markdown file absolute path → registered harness name */
  private readonly harnessFiles = new Map<string, string>();
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly hooks: AgentboxHooks;
  private readonly metrics = {
    totalRuns: 0,
    byStatus: {} as Partial<Record<RunStatus, number>>,
    totalDurationMs: 0,
  };

  constructor(opts: AgentboxOptions = {}) {
    const baseDir = path.resolve(opts.baseDir ?? '.agentbox');
    this.baseDir = baseDir;
    const providers = new Map<SandboxKind, SandboxProvider>();
    providers.set('local', new LocalSandboxProvider(path.join(baseDir, 'sessions')));
    for (const provider of opts.sandboxProviders ?? []) {
      providers.set(provider.kind, provider);
    }
    this.sessions = new SessionManager(providers, {
      idleTtlMs: opts.session?.idleTtlMs ?? 30 * 60_000,
      maxSessions: opts.session?.maxSessions ?? 256,
    });
    this.scheduler = new FairScheduler(opts.maxConcurrentRuns ?? 4, {
      maxPerLane: opts.maxConcurrentRunsPerUser,
      maxQueued: opts.maxQueuedRuns,
      queueTimeoutMs: opts.queueTimeoutMs,
    });
    this.hooks = opts.hooks ?? {};
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

  /**
   * Loads every installed harness pack from a packs directory (default
   * <baseDir>/packs — populated by `agentbox add` or PackManager.install).
   * Packs load in name order; later packs override same-named harnesses.
   */
  async loadHarnessPacks(opts: { dir?: string; watch?: boolean } = {}): Promise<PackInfo[]> {
    const packsDir = opts.dir ?? path.join(this.baseDir, 'packs');
    const manager = new PackManager(packsDir);
    const packs = await manager.list();
    for (const pack of packs) {
      await this.loadHarnessDir(pack.harnessDir, { watch: opts.watch });
    }
    return packs;
  }

  /**
   * Loads all `*.md` harness files in a directory (frontmatter → spec,
   * body → system prompt). With `watch: true`, file changes are hot-reloaded:
   * edits re-register, deletions unregister, and parse errors keep the
   * previous registration in place.
   */
  async loadHarnessDir(dir: string, opts: { watch?: boolean } = {}): Promise<HarnessSpec[]> {
    const absDir = path.resolve(dir);
    const specs: HarnessSpec[] = [];
    for (const file of await listHarnessFiles(absDir)) {
      const spec = await loadHarnessFile(file);
      this.registry.upsert(spec);
      this.harnessFiles.set(file, spec.name);
      specs.push(spec);
    }
    if (opts.watch) this.watchHarnessDir(absDir);
    return specs;
  }

  private watchHarnessDir(absDir: string): void {
    const timers = new Map<string, NodeJS.Timeout>();
    const watcher = watch(absDir, (_event, filename) => {
      if (!filename || !filename.endsWith('.md')) return;
      const file = path.join(absDir, filename);
      clearTimeout(timers.get(file));
      timers.set(
        file,
        setTimeout(() => {
          timers.delete(file);
          void this.reloadHarnessFile(file);
        }, 50),
      );
    });
    watcher.unref?.();
    this.watchers.push(watcher);
  }

  private async reloadHarnessFile(file: string): Promise<void> {
    try {
      const spec = await loadHarnessFile(file);
      const previous = this.harnessFiles.get(file);
      if (previous && previous !== spec.name) this.registry.unregister(previous);
      this.registry.upsert(spec);
      this.harnessFiles.set(file, spec.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        const previous = this.harnessFiles.get(file);
        if (previous) {
          this.registry.unregister(previous);
          this.harnessFiles.delete(file);
        }
      }
      // Parse errors keep the previous registration so a mid-edit save cannot
      // knock a harness out of a running server.
    }
  }

  async run(request: RunRequest, onEvent: (event: RunEvent) => void = () => {}): Promise<RunResult> {
    const harness = this.registry.get(request.harness);
    const driver = this.drivers.get(harness.backend);
    if (!driver) throw new Error(`no driver registered for backend "${harness.backend}"`);

    const runId = randomUUID();
    const startedAt = Date.now();
    const emit = (event: RunEvent) => {
      onEvent(event);
      void this.safeHook(() => this.hooks.onEvent?.(runId, event));
    };
    const session = await this.sessions.acquire(request.session, harness.sandbox ?? 'local', harness.workspace);
    const abort = new AbortController();
    this.activeRuns.set(runId, abort);
    emit({ type: 'run:start', runId, sessionId: session.id, harness: harness.name });
    await this.safeHook(() => this.hooks.onRunStart?.({ runId, request, harness }));

    let outcome: DriverOutcome;
    try {
      outcome = await this.scheduler.schedule(request.session.userId, () =>
        session.runExclusive(() =>
          this.runAttempts(runId, request, harness, driver, session, abort.signal, emit),
        ),
      );
    } catch (err) {
      // Backpressure surfaces as a failed result, not a thrown error, so the
      // caller and the SSE stream both see a terminal run state.
      if (err instanceof QueueFullError || err instanceof QueueTimeoutError) {
        outcome = { status: 'failed', finalText: '', error: err.message };
      } else {
        this.activeRuns.delete(runId);
        throw err;
      }
    } finally {
      this.activeRuns.delete(runId);
    }

    if (outcome.status === 'succeeded' && harness.limits?.maxWorkspaceBytes !== undefined) {
      const used = await session.sandbox.usage();
      if (used > harness.limits.maxWorkspaceBytes) {
        outcome = {
          status: 'failed',
          finalText: outcome.finalText,
          error: `workspace exceeds quota (${used} > ${harness.limits.maxWorkspaceBytes} bytes)`,
        };
      }
    }

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
    this.metrics.totalRuns++;
    this.metrics.byStatus[result.status] = (this.metrics.byStatus[result.status] ?? 0) + 1;
    this.metrics.totalDurationMs += result.durationMs;
    if (outcome.status === 'succeeded') {
      emit({ type: 'run:done', result });
    } else {
      emit({ type: 'run:error', error: outcome.error ?? outcome.status, result });
    }
    await this.safeHook(() => this.hooks.onRunEnd?.(result, request));
    return result;
  }

  /** Retry loop; runs inside the session's exclusive slot so attempts stay serialized. */
  private async runAttempts(
    runId: string,
    request: RunRequest,
    harness: HarnessSpec,
    driver: AgentDriver,
    session: Awaited<ReturnType<SessionManager['acquire']>>,
    signal: AbortSignal,
    emit: (event: RunEvent) => void,
  ): Promise<DriverOutcome> {
    const maxAttempts = Math.max(1, harness.retry?.maxAttempts ?? 1);
    const retryOn = new Set<RunStatus>(harness.retry?.on ?? ['failed', 'timeout']);
    let outcome: DriverOutcome = { status: 'cancelled', finalText: '' };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Cancelled while queued or between attempts: skip the driver entirely.
      if (signal.aborted) return { status: 'cancelled', finalText: outcome.finalText };
      outcome = await driver.run(
        {
          runId,
          harness,
          prompt: request.prompt,
          sandbox: session.sandbox,
          state: session.stateFor(harness.backend),
          signal,
        },
        emit,
      );
      const retryable = retryOn.has(outcome.status) && outcome.status !== 'cancelled';
      if (!retryable || attempt === maxAttempts) return outcome;
      emit({ type: 'run:retry', runId, attempt: attempt + 1, reason: outcome.error ?? outcome.status });
    }
    return outcome;
  }

  private async safeHook(fn: () => unknown): Promise<void> {
    try {
      await fn();
    } catch {
      // Hooks are observability; they must never break a run.
    }
  }

  /**
   * Cancels a run by id (obtained from the run:start event). A running
   * driver is killed; a queued run is dropped before it ever spawns.
   * Returns false when the run is unknown or already finished.
   */
  cancel(runId: string): boolean {
    const abort = this.activeRuns.get(runId);
    if (!abort) return false;
    abort.abort();
    return true;
  }

  get stats(): AgentboxStats {
    return {
      sessions: this.sessions.size,
      runningRuns: this.scheduler.runningCount,
      queuedRuns: this.scheduler.pendingCount,
      activeRuns: this.activeRuns.size,
      totalRuns: this.metrics.totalRuns,
      byStatus: { ...this.metrics.byStatus },
      avgDurationMs:
        this.metrics.totalRuns === 0
          ? 0
          : Math.round(this.metrics.totalDurationMs / this.metrics.totalRuns),
    };
  }

  /**
   * Shuts the runtime down. With `drainMs`, waits up to that long for
   * in-flight runs to finish before tearing sessions down.
   */
  async close(opts: { drainMs?: number } = {}): Promise<void> {
    const deadline = Date.now() + (opts.drainMs ?? 0);
    while (this.activeRuns.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    for (const watcher of this.watchers) watcher.close();
    this.watchers.length = 0;
    await this.sessions.close();
  }
}
