/** Supported agent backends. Extendable by injecting custom drivers. */
export type AgentBackend = 'pi' | 'codex' | 'claude';

export type SandboxKind = 'local' | 'container';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** The tool surface a harness grants the agent. Backend mapping is the driver's job. */
export interface ToolPolicy {
  /** Backend-native tool name allowlist (e.g. claude's "Bash(node:*)", "Write") */
  allow?: string[];
  deny?: string[];
  mcpServers?: Record<string, McpServerConfig>;
}

export interface WorkspaceSpec {
  /**
   * Name of a pre-built workspace snapshot to clone from (copy-on-write
   * where the filesystem supports it). Built via SnapshotManager/box.snapshots.
   */
  snapshot?: string;
  /** Template directory copied into the session workspace on creation */
  templateDir?: string;
  /** Relative path → content, written as seed files on workspace creation */
  seedFiles?: Record<string, string>;
}

export interface HarnessLimits {
  maxTurns?: number;
  timeoutMs?: number;
  /** Fail the run when the session workspace exceeds this size after the run */
  maxWorkspaceBytes?: number;
  /**
   * Directory names excluded from the maxWorkspaceBytes quota walk (e.g.
   * ["node_modules"]). Opt-in: by default the quota counts the whole
   * workspace, since that is real disk usage. Set this only when the quota
   * is meant to bound generated output rather than build dependencies.
   */
  workspaceQuotaExcludes?: string[];
}

export interface RetryPolicy {
  /** Total attempts including the first one (>= 1) */
  maxAttempts: number;
  /** Statuses that trigger a retry. Defaults to ['failed', 'timeout']. */
  on?: RunStatus[];
}

/**
 * A harness is the execution profile of one task type (PPT generation,
 * bash script generation, …): agent backend + tool surface + artifact contract.
 */
export interface HarnessSpec {
  name: string;
  description?: string;
  backend: AgentBackend;
  model?: string;
  systemPrompt?: string;
  tools?: ToolPolicy;
  workspace?: WorkspaceSpec;
  /** Artifact globs collected from the workspace after the run ends */
  artifacts?: { globs: string[] };
  limits?: HarnessLimits;
  /** Retry policy for transient failures. Cancelled runs are never retried. */
  retry?: RetryPolicy;
  sandbox?: SandboxKind;
  /**
   * Environment variable names forwarded from the server process into this
   * harness's runs (on top of the framework base allowlist). Scopes secrets
   * per task type instead of exposing everything to every agent.
   */
  env?: string[];
  /** Driver-specific options (CLI path, argument overrides, …) */
  driverOptions?: Record<string, unknown>;
}

/** Session identity. One session = one user's one goal = one workspace. */
export interface SessionKey {
  userId: string;
  goalId: string;
}

export interface RunRequest {
  session: SessionKey;
  harness: string;
  prompt: string;
}

export interface Artifact {
  /** Path relative to the workspace root */
  path: string;
  absPath: string;
  bytes: number;
  /** Where the artifact was uploaded, when an ArtifactStore is configured */
  url?: string;
}

/**
 * Uploads run artifacts to durable storage (S3, local archive, …) after
 * collection. Returns the artifacts, typically annotated with url.
 */
export interface ArtifactStore {
  store(runId: string, artifacts: Artifact[]): Promise<Artifact[]>;
}

export type RunStatus = 'succeeded' | 'failed' | 'cancelled' | 'timeout';

export interface RunResult {
  runId: string;
  harness: string;
  sessionId: string;
  session: SessionKey;
  status: RunStatus;
  finalText: string;
  artifacts: Artifact[];
  durationMs: number;
  /** Tool calls the agent made this run (counted from the event stream) */
  toolCalls: number;
  error?: string;
}

export type RunEvent =
  | { type: 'run:start'; runId: string; sessionId: string; harness: string }
  | { type: 'agent:message'; text: string }
  | { type: 'agent:thinking'; text: string }
  | { type: 'tool:call'; name: string; input?: unknown }
  | { type: 'tool:result'; name: string; ok: boolean; detail?: string }
  | { type: 'run:retry'; runId: string; attempt: number; reason: string }
  | { type: 'run:done'; result: RunResult }
  | { type: 'run:error'; error: string; result?: RunResult };

/** Per-backend state used for warm resume (claude session id, codex thread id, …) */
export interface BackendSessionState {
  resumeId?: string;
}

export interface CommandSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface Sandbox {
  readonly kind: SandboxKind;
  /** Absolute workspace root. Drivers must operate only inside it. */
  readonly root: string;
  writeFile(relPath: string, content: string | Uint8Array): Promise<void>;
  collect(globs: string[]): Promise<Artifact[]>;
  /**
   * Adapts a host command invocation to run inside the sandbox boundary
   * (identity for the local sandbox, `docker run ...` for containers).
   */
  wrapCommand(spec: CommandSpec): CommandSpec;
  /**
   * Total bytes currently stored in the workspace (for quota enforcement).
   * `excludeDirs` names top-of-tree directory names to skip (e.g.
   * "node_modules"); omit to count everything.
   */
  usage(excludeDirs?: string[]): Promise<number>;
  destroy(): Promise<void>;
}

export interface SandboxProvider {
  readonly kind: SandboxKind;
  create(id: string, spec?: WorkspaceSpec): Promise<Sandbox>;
}

export interface DriverContext {
  runId: string;
  harness: HarnessSpec;
  prompt: string;
  sandbox: Sandbox;
  /** Backend state held by the session; the driver updates resumeId. */
  state: BackendSessionState;
  signal: AbortSignal;
}

export interface DriverOutcome {
  status: RunStatus;
  finalText: string;
  error?: string;
}

export interface AgentDriver {
  readonly backend: AgentBackend;
  run(ctx: DriverContext, emit: (event: RunEvent) => void): Promise<DriverOutcome>;
}
