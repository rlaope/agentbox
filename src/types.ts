/** 지원하는 agent 백엔드 종류. 드라이버 주입으로 확장 가능하다. */
export type AgentBackend = 'pi' | 'codex' | 'claude';

export type SandboxKind = 'local' | 'container';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** 하네스가 agent에 허용하는 tool 표면. 백엔드별 매핑은 드라이버가 담당한다. */
export interface ToolPolicy {
  /** 백엔드 네이티브 tool 이름 allowlist (예: claude의 "Bash(node:*)", "Write") */
  allow?: string[];
  deny?: string[];
  mcpServers?: Record<string, McpServerConfig>;
}

export interface WorkspaceSpec {
  /** 세션 워크스페이스 생성 시 복사할 템플릿 디렉토리 */
  templateDir?: string;
  /** 상대경로 → 내용. 워크스페이스 생성 시 시드 파일로 기록 */
  seedFiles?: Record<string, string>;
}

export interface HarnessLimits {
  maxTurns?: number;
  timeoutMs?: number;
}

/**
 * 하네스 = 특정 작업 유형(ppt 생성, bash 스크립트 생성 등)에 맞춰
 * agent 백엔드 + tool 표면 + 산출물 계약을 선언한 실행 프로파일.
 */
export interface HarnessSpec {
  name: string;
  description?: string;
  backend: AgentBackend;
  model?: string;
  systemPrompt?: string;
  tools?: ToolPolicy;
  workspace?: WorkspaceSpec;
  /** run 종료 후 워크스페이스에서 수집할 산출물 glob 목록 */
  artifacts?: { globs: string[] };
  limits?: HarnessLimits;
  sandbox?: SandboxKind;
  /** 드라이버별 세부 옵션 (CLI 경로, 인자 오버라이드 등) */
  driverOptions?: Record<string, unknown>;
}

/** 세션 식별자. 세션 = 유저 1명의 작업 목표 1개 = 워크스페이스 1개. */
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
  /** 워크스페이스 루트 기준 상대경로 */
  path: string;
  absPath: string;
  bytes: number;
}

export type RunStatus = 'succeeded' | 'failed' | 'cancelled' | 'timeout';

export interface RunResult {
  runId: string;
  status: RunStatus;
  finalText: string;
  artifacts: Artifact[];
  durationMs: number;
  error?: string;
}

export type RunEvent =
  | { type: 'run:start'; runId: string; sessionId: string; harness: string }
  | { type: 'agent:message'; text: string }
  | { type: 'agent:thinking'; text: string }
  | { type: 'tool:call'; name: string; input?: unknown }
  | { type: 'tool:result'; name: string; ok: boolean; detail?: string }
  | { type: 'run:done'; result: RunResult }
  | { type: 'run:error'; error: string; result?: RunResult };

/** 백엔드가 warm resume에 쓰는 세션 상태 (claude session id, codex thread id 등) */
export interface BackendSessionState {
  resumeId?: string;
}

export interface Sandbox {
  readonly kind: SandboxKind;
  /** 워크스페이스 루트 절대경로. 드라이버는 이 안에서만 작업한다. */
  readonly root: string;
  writeFile(relPath: string, content: string | Uint8Array): Promise<void>;
  collect(globs: string[]): Promise<Artifact[]>;
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
  /** 세션이 보관하는 백엔드 상태. 드라이버가 resumeId를 갱신한다. */
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
