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
The `SandboxProvider` interface (`create(id, spec) → Sandbox`) hides the isolation implementation, and `Sandbox.wrapCommand` decides how a driver's CLI invocation crosses the boundary (identity for `local`, `docker run ...` for containers). A harness opts in with `sandbox: 'container'`.

`ContainerSandboxProvider` (v0.3) implements **workspace owned by the session, execution environment leased per run** — not one always-on container per session. The workspace stays a host directory bind-mounted into an ephemeral `docker run --rm` container, so seeding and artifact collection are identical to the local sandbox. A per-session home directory (`.agentbox-home`) is mounted as the container HOME so backend resume state survives across ephemeral containers. Image, runtime (docker/podman), network mode, env passthrough, and extra `docker run` args (resource limits, seccomp) are provider options. A microVM provider can plug in behind the same interface later.

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

## 7. Harness authoring layers

Task types are unbounded, so the framework does not try to ship them. The core owns primitives only (sessions, isolation, scheduling, drivers) and keeps a handful of reference harnesses; everything else comes from the layers below.

1. **Markdown (the 80% case)** — the authoring format. A harness file is skill-shaped: YAML frontmatter maps 1:1 onto `HarnessSpec` fields, the body becomes `systemPrompt`, and `name` defaults to the file basename. `box.loadHarnessDir(dir, { watch: true })` registers every `*.md` in a directory and hot-reloads on change: edits re-register, deletions unregister, and a mid-edit broken save keeps the previous registration in place. One markdown file = one task type.
2. **TypeScript `defineHarness` (the 20% escape hatch)** — `HarnessSpec` is the intermediate representation both layers produce. Anything declaration cannot express — custom drivers, dynamic tool policies, conditional workspace seeding — is written in code against the same spec.
3. **Harness packs (roadmap)** — directories of markdown harnesses distributed via npm/git and installed into a deployment, the way skill marketplaces work.

The direction is deliberately one-way: markdown compiles down to the spec. There is no code→markdown converter — code expresses functions and conditionals that markdown cannot, so such a conversion would be lossy and the converter itself a maintenance sink.

## 8. Event and artifact contract

All backend output is normalized into a common `RunEvent` stream: `run:start`, `agent:message`, `agent:thinking`, `tool:call`, `tool:result`, `run:done`, `run:error`. The HTTP facade relays these as SSE, so a SaaS client can render progress without knowing which backend is underneath.

Artifacts are declared as `artifacts.globs` on the harness. After the run ends, matching files are collected from the workspace and returned as `RunResult.artifacts` (relative path, absolute path, size). Serving the files (issuing download URLs etc.) is the responsibility of the SaaS layer outside the framework.

## 9. API

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
- `DELETE /v1/runs/{runId}` — cancel a run (id from the `run:start` event); kills a running driver, drops a queued run before it spawns
- `GET /v1/harnesses` — registered harness list
- `GET /v1/stats` — session count / running runs / queued runs

## 10. Assumptions to verify

- **pi CLI invocation shape**: the default is `pi -p "<prompt>"`. If the deployed pi version differs, override via `driverOptions.command / args`; the default will be updated once confirmed.
- **codex `--json` event schema**: experimental, fields may change. The parser is written defensively and ignores unrecognized lines.
- **claude stream-json**: based on the `system:init / assistant / user / result` message types; re-verify on CLI upgrades.

## 11. Roadmap

- **v0.2 (shipped)** — markdown harness authoring (`loadHarnessDir`) with hot reload
- **v0.3 (shipped)** — container `SandboxProvider` (workspace volume = session, ephemeral execution containers per run), run cancellation (`Agentbox.cancel`, `DELETE /v1/runs/{id}`)
- **v0.4** — harness packs (npm/git distribution of markdown harness directories), artifact store integration (S3, …), pi programmatic tool registration, MCP server injection (`tools.mcpServers`) across all backends
- **v0.5** — metrics (run latency / tokens / failure rate), warm session pools (predictive pre-warming), multi-node scheduling (session→node affinity)
