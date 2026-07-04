# agentbox Design Document

The AI Agent Framework — Sandboxed Multi-Agent Orchestration, High-Throughput Stateful Agents, Modular Agent Session Manager & Runtime.

## 1. Background and problem

A growing pattern in SaaS products is to use coding agents (codex, claude code, pi) as a server-side execution engine. Example: in a PPT-generation SaaS, a user types a prompt, the server opens a codex session, the agent writes and executes scripts inside a workspace, and a `.pptx` comes back. Document generation, image generation, and bash script generation follow the same shape.

Operating this in production means solving four problems at the same time:

1. **Isolation** — file areas of different users/projects must never mix.
2. **Throughput** — the server must handle many concurrent requests and sessions, and follow-up requests for the same unit of work should reuse an already-warm session.
3. **Minimal tool surface** — a general-purpose coding agent is slower and riskier the more tools it has. "Generate a PPT" only needs file writes and `node` execution. The tool surface must be cut down declaratively per task type.
4. **Pluggable backends** — the same harness must be able to run on pi, codex, or claude.

agentbox makes these four the core contract of the framework.

## 2. Concept model

| Concept | Definition |
|---|---|
| **Harness** | The execution profile of one task type. Declares backend + model + system prompt + tool policy + workspace seed + artifact contract + limits (turns/time). |
| **Session** | One `(userId, goalId)` pair. Owns one workspace and per-backend resume state. Not created per request. |
| **Run** | One execution of one prompt with one harness inside a session. |
| **Sandbox** | The isolation implementation behind a session workspace. `local` (process-level) is the default; container/microVM providers plug in behind the same interface. |
| **Driver** | An agent backend adapter. Translates the harness declaration into backend-native options and normalizes the output stream into common events. |
| **Artifact** | An output file collected from the workspace by glob after the run ends. |

## 3. Architecture

```
                    ┌──────────────────────────────────────────────┐
 SaaS client        │ agentbox                                     │
   │  POST /v1/runs │                                              │
   ▼                │  ┌───────────┐   ┌──────────────────────┐    │
 HTTP facade ───────┼─▶│ Harness   │   │ FairScheduler        │    │
 (SSE stream)       │  │ Registry  │   │ global concurrency   │    │
                    │  └───────────┘   │ cap + user lane RR   │    │
                    │        │         └──────────┬───────────┘    │
                    │        ▼                    ▼                │
                    │  ┌──────────────────────────────────────┐    │
                    │  │ SessionManager                       │    │
                    │  │  (userId, goalId) → Session          │    │
                    │  │  serialized runs, idle TTL reaping   │    │
                    │  └──────┬───────────────────────────────┘    │
                    │         ▼                                    │
                    │  ┌────────────┐      ┌─────────────────┐     │
                    │  │ Sandbox    │◀────▶│ Driver          │     │
                    │  │ local /    │ cwd  │ pi | codex |    │     │
                    │  │ container  │      │ claude          │     │
                    │  └────────────┘      └─────────────────┘     │
                    │         │                                    │
                    │         ▼ artifact collect (globs)           │
                    └──────────────────────────────────────────────┘
```

Lifetime of one request: `POST /v1/runs` → harness lookup → session acquisition (reused if warm) → scheduler queue → serialized execution slot within the session → driver spawns the CLI (cwd = workspace) → output stream normalized into `RunEvent`s and relayed over SSE → artifact globs collected after exit → `RunResult` returned.

## 4. Isolation model

### Session-level isolation
A container per request is overkill, so the unit of isolation is **a session = one user's one goal**. Each session gets a dedicated workspace directory, and drivers always spawn the CLI with that directory as cwd.

- `LocalSandbox.writeFile` resolves paths and rejects escapes (`../`) outside the root.
- Child process environment passes through an allowlist only (`PATH`, `HOME`, API keys, …), reducing the surface through which server-process secrets could leak into a workspace.
- Backends enforce a second layer themselves: codex via `--sandbox workspace-write`, claude via the tool allowlist.

### Sandbox provider abstraction
The `SandboxProvider` interface (`create(id, spec) → Sandbox`) hides the isolation implementation. v0.1 ships `local` only (same host, directory isolation). When a stronger trust boundary is needed, a container provider (per-session volume + pooled execution containers) or a microVM provider plugs in behind the same interface, and a harness opts in with `sandbox: 'container'`. The roadmap direction is **workspace (volume) owned by the session, execution environment leased from a pool** — not one always-on container per session.

## 5. Throughput strategy

1. **Session reuse (stateful warm sessions)** — requests for the same `(userId, goalId)` route to the same session. The workspace persists, so installed dependencies and intermediate outputs are reused, and the driver stores the backend resume id (claude `--resume`, codex `exec resume`) on the session, eliminating conversation-context rebuild cost.
2. **Global concurrency cap + fairness** — `FairScheduler` bounds the number of concurrent runs server-wide (default 4) and round-robins across userId lanes so one user's burst cannot starve others.
3. **Serialization within a session** — runs arriving concurrently for one session execute in arrival order. This structurally prevents file-area contention and resume-id races. Different sessions run in parallel.
4. **Resource reaping** — a sweeper reclaims sessions idle past the TTL (default 30 min), workspace included. At the session-count cap, the LRU idle session is evicted first.

## 6. Minimizing the tool surface

A harness declares `tools.allow / tools.deny`; the driver translates them into backend-native options.

| Backend | Mapping | Granularity |
|---|---|---|
| claude | `--allowedTools`, `--disallowedTools`, `--max-turns` | per-tool + patterns (`Bash(node:*)`) — finest |
| codex | `--sandbox read-only\|workspace-write\|danger-full-access` | sandbox-mode level — coarse; prefer claude/pi when fine-grained control matters |
| pi | programmatic tool registration (custom adapter extension point) | v0.1 is one-shot CLI execution; tool control is follow-up work |

A narrower tool surface (1) cuts the turns an agent wastes exploring, lowering latency and cost, and (2) shrinks the blast radius under prompt injection. `limits.maxTurns` / `limits.timeoutMs` bound runaway runs.

## 7. Event and artifact contract

All backend output is normalized into a common `RunEvent` stream: `run:start`, `agent:message`, `agent:thinking`, `tool:call`, `tool:result`, `run:done`, `run:error`. The HTTP facade relays these as SSE, so a SaaS client can render progress without knowing which backend is underneath.

Artifacts are declared as `artifacts.globs` on the harness. After the run ends, matching files are collected from the workspace and returned as `RunResult.artifacts` (relative path, absolute path, size). Serving the files (issuing download URLs etc.) is the responsibility of the SaaS layer outside the framework.

## 8. API

### Embedded SDK

```ts
const box = new Agentbox({ maxConcurrentRuns: 8 });
box.register(pptGenerate);

const result = await box.run(
  { session: { userId: 'u1', goalId: 'q2-deck' }, harness: 'ppt-generate', prompt: 'Q2 results deck' },
  (event) => console.log(event),
);
// result.artifacts → [{ path: 'out/deck.pptx', ... }]
```

### HTTP facade
- `POST /v1/runs` — body `{ session: { userId, goalId }, harness, prompt }`; response is an SSE event stream
- `GET /v1/harnesses` — registered harness list
- `GET /v1/stats` — session count / running runs / queued runs

## 9. Assumptions to verify

- **pi CLI invocation shape**: the default is `pi -p "<prompt>"`. If the deployed pi version differs, override via `driverOptions.command / args`; the default will be updated once confirmed.
- **codex `--json` event schema**: experimental, fields may change. The parser is written defensively and ignores unrecognized lines.
- **claude stream-json**: based on the `system:init / assistant / user / result` message types; re-verify on CLI upgrades.

## 10. Roadmap

- **v0.2** — container `SandboxProvider` (volume = session, pooled execution containers), run cancellation API, artifact store integration (S3, …)
- **v0.3** — pi programmatic tool registration (custom tools declared on the harness), MCP server injection (`tools.mcpServers`) across all backends
- **v0.4** — metrics (run latency / tokens / failure rate), warm session pools (predictive pre-warming), multi-node scheduling (session→node affinity)
