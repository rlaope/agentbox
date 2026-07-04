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

### Prior art

The design deliberately borrows from — and positions against — neighboring systems:

- **Sandbox infrastructure (E2B, Daytona, Modal, Fly Machines)** — the execution-layer providers. E2B runs each sandbox in a Firecracker microVM with a dedicated kernel; Daytona uses containers with warm pools and snapshot-restore for sub-100ms creation. agentbox sits one layer above: it orchestrates *agent harnesses* rather than raw code execution, and its `SandboxProvider` interface is where such providers plug in (local → container today, microVM-backed later). Their layered-isolation and workspace-quota ideas inform the per-harness env allowlists and `maxWorkspaceBytes` limits.
- **Claude Agent SDK / Claude Code hooks** — the hook system (callbacks on lifecycle events, middleware-style) inspired `AgentboxHooks`. The SDK deliberately ships without built-in retry, telemetry, backpressure, or multi-tenant scheduling — exactly the operational layer a SaaS needs and exactly what agentbox provides on top (`retry` policies, `stats` metrics, bounded queues, per-user fairness).
- **Server-side orchestration** — centralizing the inference→tool→inference loop inside the server trust boundary enables policy enforcement (tool allowlists, quotas, cancellation) at the cost of client flexibility; agentbox accepts that trade-off deliberately because isolation and governance are the point.

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
- Secrets are additionally scoped per task type: `HarnessSpec.env` names extra variables forwarded only into that harness's runs (and across the container boundary via `-e`), so a PPT harness never sees the search harness's credentials.
- `limits.maxWorkspaceBytes` enforces a per-session disk quota after each run; a run that blows the quota is failed rather than silently filling the host.
- Backends enforce a second layer themselves: codex via `--sandbox workspace-write`, claude via the tool allowlist.

### Sandbox provider abstraction
The `SandboxProvider` interface (`create(id, spec) → Sandbox`) hides the isolation implementation, and `Sandbox.wrapCommand` decides how a driver's CLI invocation crosses the boundary (identity for `local`, `docker run ...` for containers). A harness opts in with `sandbox: 'container'`.

`ContainerSandboxProvider` (v0.3) implements **workspace owned by the session, execution environment leased per run** — not one always-on container per session. The workspace stays a host directory bind-mounted into an ephemeral `docker run --rm` container, so seeding and artifact collection are identical to the local sandbox. A per-session home directory (`.agentbox-home`) is mounted as the container HOME so backend resume state survives across ephemeral containers. Image, runtime (docker/podman), network mode, env passthrough, and extra `docker run` args (resource limits, seccomp) are provider options. A microVM provider can plug in behind the same interface later.

## 5. Throughput strategy

1. **Session reuse (stateful warm sessions)** — requests for the same `(userId, goalId)` route to the same session. The workspace persists, so installed dependencies and intermediate outputs are reused, and the driver stores the backend resume id (claude `--resume`, codex `exec resume`) on the session, eliminating conversation-context rebuild cost.
2. **Global concurrency cap + fairness** — `FairScheduler` bounds the number of concurrent runs server-wide (default 4), round-robins across userId lanes so one user's burst cannot starve others, and optionally caps concurrent runs per user (`maxConcurrentRunsPerUser`) so a single tenant cannot hold every slot.
3. **Bounded queueing (backpressure)** — `maxQueuedRuns` fails excess submissions fast with a `queue is full` result instead of building an unbounded backlog, and `queueTimeoutMs` fails runs that wait too long. Backpressure only applies to jobs that would actually wait; a job with a free slot always runs.
4. **Serialization within a session** — runs arriving concurrently for one session execute in arrival order. This structurally prevents file-area contention and resume-id races. Different sessions run in parallel.
5. **Retry without re-queueing** — a harness `retry` policy re-runs transient failures (`failed`/`timeout`, never `cancelled`) inside the already-held session slot, emitting `run:retry` events, so retries cost no extra queue trips.
6. **Resource reaping** — a sweeper reclaims sessions idle past the TTL (default 30 min), workspace included. At the session-count cap, the LRU idle session is evicted first. `close({ drainMs })` drains in-flight runs before teardown.

## 6. Minimizing the tool surface

A harness declares `tools.allow / tools.deny`; the driver translates them into backend-native options.

| Backend | Mapping | Granularity |
|---|---|---|
| claude | `--allowedTools`, `--disallowedTools`, `--max-turns` | per-tool + patterns (`Bash(node:*)`) — finest |
| codex | `--sandbox read-only\|workspace-write\|danger-full-access` | sandbox-mode level — coarse; prefer claude/pi when fine-grained control matters |
| pi | programmatic tool registration (custom adapter extension point) | v0.1 is one-shot CLI execution; tool control is follow-up work |

A narrower tool surface (1) cuts the turns an agent wastes exploring, lowering latency and cost, and (2) shrinks the blast radius under prompt injection. `limits.maxTurns` / `limits.timeoutMs` bound runaway runs.

Custom tools enter through `tools.mcpServers`: declared MCP servers are written into the workspace as `.agentbox.mcp.json` and injected into the claude backend via `--mcp-config` with `--strict-mcp-config`, so the harness declaration remains the complete, closed tool surface — the agent gets exactly the declared servers and nothing else.

## 7. Harness authoring layers

Task types are unbounded, so the framework does not try to ship them. The core owns primitives only (sessions, isolation, scheduling, drivers) and keeps a handful of reference harnesses; everything else comes from the layers below.

1. **Markdown (the 80% case)** — the authoring format. A harness file is skill-shaped: YAML frontmatter maps 1:1 onto `HarnessSpec` fields, the body becomes `systemPrompt`, and `name` defaults to the file basename. `box.loadHarnessDir(dir, { watch: true })` registers every `*.md` in a directory and hot-reloads on change: edits re-register, deletions unregister, and a mid-edit broken save keeps the previous registration in place. One markdown file = one task type.
2. **TypeScript `defineHarness` (the 20% escape hatch)** — `HarnessSpec` is the intermediate representation both layers produce. Anything declaration cannot express — custom drivers, dynamic tool policies, conditional workspace seeding — is written in code against the same spec.
3. **Harness packs (v0.5)** — directories of markdown harnesses distributed via git or shared as local folders, the way skill marketplaces work. `agentbox add <git-url|dir>` installs a pack into `.agentbox/packs` (staged and validated first, so a broken pack never lands), an optional `agentbox-pack.json` manifest carries name/version/description and the harness subdirectory, and `box.loadHarnessPacks()` registers every installed pack at boot — in name order, later packs overriding same-named harnesses. `agentbox list` / `agentbox remove` manage the installation.

The direction is deliberately one-way: markdown compiles down to the spec. There is no code→markdown converter — code expresses functions and conditionals that markdown cannot, so such a conversion would be lossy and the converter itself a maintenance sink.

## 8. Event and artifact contract

All backend output is normalized into a common `RunEvent` stream: `run:start`, `agent:message`, `agent:thinking`, `tool:call`, `tool:result`, `run:done`, `run:error`. The HTTP facade relays these as SSE, so a SaaS client can render progress without knowing which backend is underneath.

Artifacts are declared as `artifacts.globs` on the harness. After the run ends, matching files are collected from the workspace and returned as `RunResult.artifacts` (relative path, absolute path, size). Serving the files (issuing download URLs etc.) is the responsibility of the SaaS layer outside the framework.

## 9. API

### Embedded SDK

```ts
const box = new Agentbox({
  maxConcurrentRuns: 8,
  maxConcurrentRunsPerUser: 2,
  maxQueuedRuns: 100,
  queueTimeoutMs: 60_000,
  hooks: {
    onRunEnd: (result) => metrics.record(result), // observability middleware
  },
});
box.register(pptGenerate);

const result = await box.run(
  { session: { userId: 'u1', goalId: 'q2-deck' }, harness: 'ppt-generate', prompt: 'Q2 results deck' },
  (event) => console.log(event),
);
// result.artifacts → [{ path: 'out/deck.pptx', ... }]
```

### HTTP facade
- `POST /v1/runs` — body `{ session: { userId, goalId }, harness, prompt }`; response is an SSE event stream
- `DELETE /v1/runs/{runId}` — cancel a run (id from the `run:start` event); kills a running driver, drops a queued run before it spawns
- `GET /v1/harnesses` — registered harness list
- `GET /v1/stats` — sessions, running/queued/active runs, totals by status, average duration

Pre-stream failures return proper status codes (404 unknown harness, 500 otherwise); queue overflow and queue timeout surface as terminal `run:error` events with a failed result rather than thrown errors.

## 10. Assumptions to verify

- **pi CLI invocation shape**: the default is `pi -p "<prompt>"`. If the deployed pi version differs, override via `driverOptions.command / args`; the default will be updated once confirmed.
- **codex `--json` event schema**: experimental, fields may change. The parser is written defensively and ignores unrecognized lines.
- **claude stream-json**: based on the `system:init / assistant / user / result` message types; re-verify on CLI upgrades.

## 11. Roadmap

- **v0.2 (shipped)** — markdown harness authoring (`loadHarnessDir`) with hot reload
- **v0.3 (shipped)** — container `SandboxProvider` (workspace volume = session, ephemeral execution containers per run), run cancellation (`Agentbox.cancel`, `DELETE /v1/runs/{id}`)
- **v0.4 (shipped)** — queue backpressure + queue timeout + per-user concurrency caps, per-harness env allowlists, workspace quotas, retry policies, lifecycle hooks, runtime metrics, graceful drain, MCP server injection for the claude backend
- **v0.5 (shipped)** — harness packs: git/local-dir distribution of markdown harness directories, `agentbox add/list/remove` CLI, `loadHarnessPacks()` runtime loading
- **v0.6** — artifact store integration (S3, …), pi programmatic tool registration, MCP injection for the remaining backends, npm-registry pack sources
- **v0.7** — warm session pools (predictive pre-warming), snapshot/restore-style fast session creation, multi-node scheduling (session→node affinity)
