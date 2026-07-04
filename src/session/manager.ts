import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentBackend,
  BackendSessionState,
  Sandbox,
  SandboxKind,
  SandboxProvider,
  SessionKey,
  WorkspaceSpec,
} from '../types.js';

/** Backend resume state persisted inside the workspace so it survives restarts. */
export const SESSION_STATE_FILE = '.agentbox-home/session-state.json';

/**
 * A session is one (userId, goalId) pair. It owns one workspace and
 * per-backend resume state, and serializes its runs so file areas
 * never contend.
 */
export class Session {
  private readonly backendState = new Map<AgentBackend, BackendSessionState>();
  private chain: Promise<unknown> = Promise.resolve();
  busy = 0;
  lastUsedAt = Date.now();

  constructor(
    readonly id: string,
    readonly key: SessionKey,
    readonly sandbox: Sandbox,
  ) {}

  stateFor(backend: AgentBackend): BackendSessionState {
    let state = this.backendState.get(backend);
    if (!state) {
      state = {};
      this.backendState.set(backend, state);
    }
    return state;
  }

  restoreState(data: Record<string, BackendSessionState>): void {
    for (const [backend, state] of Object.entries(data)) {
      this.backendState.set(backend as AgentBackend, state);
    }
  }

  /** Persists resume state into the workspace; failures never break a run. */
  async persistState(): Promise<void> {
    try {
      const data = Object.fromEntries(this.backendState);
      await this.sandbox.writeFile(SESSION_STATE_FILE, JSON.stringify(data));
    } catch {
      // Best-effort: a session without persisted state just resumes cold.
    }
  }

  /** Runs jobs for this session serially, in arrival order. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.busy++;
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run.finally(() => {
      this.busy--;
      this.lastUsedAt = Date.now();
    });
  }
}

export function sessionIdOf(key: SessionKey): string {
  const raw = `${key.userId} ${key.goalId}`;
  const hash = createHash('sha1').update(raw).digest('hex').slice(0, 8);
  const slug = `${key.userId}-${key.goalId}`.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  return `${slug}-${hash}`;
}

export interface SessionManagerOptions {
  idleTtlMs: number;
  maxSessions: number;
  sweepIntervalMs?: number;
}

export class SessionManager {
  private readonly pending = new Map<string, Promise<Session>>();
  private readonly resolved = new Map<string, Session>();
  private readonly sweeper?: NodeJS.Timeout;

  constructor(
    private readonly providers: Map<SandboxKind, SandboxProvider>,
    private readonly opts: SessionManagerOptions,
  ) {
    const interval = opts.sweepIntervalMs ?? 60_000;
    this.sweeper = setInterval(() => void this.sweep(), interval);
    this.sweeper.unref?.();
  }

  /** Reuses a warm session when present, creates one otherwise. Concurrent acquires create at most once. */
  acquire(key: SessionKey, kind: SandboxKind, workspace?: WorkspaceSpec): Promise<Session> {
    const id = sessionIdOf(key);
    let promise = this.pending.get(id);
    if (!promise) {
      promise = this.create(id, key, kind, workspace);
      this.pending.set(id, promise);
      promise
        .then((session) => this.resolved.set(id, session))
        .catch(() => this.pending.delete(id));
    }
    return promise;
  }

  private async create(id: string, key: SessionKey, kind: SandboxKind, workspace?: WorkspaceSpec): Promise<Session> {
    if (this.pending.size > this.opts.maxSessions) {
      const evicted = await this.evictOldestIdle();
      if (!evicted) throw new Error(`session capacity reached (${this.opts.maxSessions})`);
    }
    const provider = this.providers.get(kind);
    if (!provider) throw new Error(`no sandbox provider registered for kind "${kind}"`);
    const sandbox = await provider.create(id, workspace);
    const session = new Session(id, key, sandbox);
    // Workspaces survive restarts; reload persisted resume state so a
    // recreated session comes back warm instead of cold.
    try {
      const raw = await readFile(path.join(sandbox.root, SESSION_STATE_FILE), 'utf8');
      session.restoreState(JSON.parse(raw) as Record<string, BackendSessionState>);
    } catch {
      // No persisted state (fresh session) or unreadable file — start cold.
    }
    return session;
  }

  private async evictOldestIdle(): Promise<boolean> {
    let oldest: Session | undefined;
    for (const session of this.resolved.values()) {
      if (session.busy > 0) continue;
      if (!oldest || session.lastUsedAt < oldest.lastUsedAt) oldest = session;
    }
    if (!oldest) return false;
    await this.evict(oldest);
    return true;
  }

  private async evict(session: Session): Promise<void> {
    this.pending.delete(session.id);
    this.resolved.delete(session.id);
    await session.sandbox.destroy();
  }

  async sweep(): Promise<void> {
    const cutoff = Date.now() - this.opts.idleTtlMs;
    for (const session of [...this.resolved.values()]) {
      if (session.busy === 0 && session.lastUsedAt < cutoff) {
        await this.evict(session);
      }
    }
  }

  get size(): number {
    return this.pending.size;
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const session of [...this.resolved.values()]) {
      await this.evict(session);
    }
    this.pending.clear();
  }
}
