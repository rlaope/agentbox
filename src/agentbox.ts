import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { ClaudeDriver } from './drivers/claude.js';
import { CodexDriver } from './drivers/codex.js';
import { PiDriver } from './drivers/pi.js';
import { listHarnessFiles, loadHarnessFile } from './harness/markdown.js';
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
  /** Root directory for session workspaces. Defaults to ./.agentbox */
  baseDir?: string;
  /** Server-wide cap on concurrent runs. Defaults to 4 */
  maxConcurrentRuns?: number;
  session?: {
    idleTtlMs?: number;
    maxSessions?: number;
  };
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
  private readonly sessions: SessionManager;
  private readonly scheduler: FairScheduler;
  private readonly drivers: Map<AgentBackend, AgentDriver>;
  private readonly watchers: FSWatcher[] = [];
  /** markdown file absolute path → registered harness name */
  private readonly harnessFiles = new Map<string, string>();

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
    for (const watcher of this.watchers) watcher.close();
    this.watchers.length = 0;
    await this.sessions.close();
  }
}
