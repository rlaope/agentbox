<p align="center">
  <img src="docs/assets/banner.png" alt="agentbox" width="100%" />
</p>

# agentbox [![npm](https://img.shields.io/npm/v/@rlaope/agentbox?label=npm%20package)](https://www.npmjs.com/package/@rlaope/agentbox) [![CI](https://github.com/rlaope/agentbox/actions/workflows/ci.yml/badge.svg)](https://github.com/rlaope/agentbox/actions/workflows/ci.yml) [![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

agentbox is a server-side framework for running coding agents (pi / codex / claude code) as your SaaS backend's execution engine. A request comes in through your API, agentbox acquires an isolated session, runs the agent inside it with a task-specific harness, and returns the artifacts. It is backend-agnostic and zero-dependency, built for the four problems that show up the moment you run agents for real: isolation, throughput, minimal tool surface, and pluggable backends.

```
user → SaaS client → API call → agentbox
        └ acquire session (reused when warm)
          → run harness (codex / claude / pi)
          → collect & return artifacts
```

> [!NOTE]
> The claude and codex drivers are verified end-to-end against the real CLIs (warm resume included); the container sandbox and egress proxy against a real docker daemon. See the [design doc](docs/DESIGN.md) for the full architecture and [CHANGELOG](CHANGELOG.md) for release history.

### Core concepts

1. [**Harness**](docs/DESIGN.md#2-concept-model) — an execution profile for one task type: backend, model, system prompt, tool allowlist, workspace seed, artifact globs, turn/time limits. Authored in TypeScript or [markdown](docs/DESIGN.md#7-harness-authoring-layers).
2. [**Session**](docs/DESIGN.md#5-throughput-strategy) — one `(userId, goalId)` pair owning one workspace and per-backend resume state. Follow-up requests reuse the warm session (claude `--resume`, codex `exec resume`); resume state survives restarts.
3. [**Sandbox**](docs/DESIGN.md#4-isolation-model) — workspace isolation behind a provider interface: process-level `local` by default, docker `container` with per-run ephemeral containers and domain-allowlist egress control.
4. [**Driver**](docs/DESIGN.md#6-minimizing-the-tool-surface) — a backend adapter that maps the harness declaration onto backend-native flags (tool allowlists, MCP injection) and normalizes output into common run events.
5. [**Scheduling**](docs/DESIGN.md#5-throughput-strategy) — a fair scheduler with a global concurrency cap, per-user round-robin lanes and caps, bounded queueing with fast-fail backpressure, and per-harness retries.
6. [**Operations**](docs/DESIGN.md#8-event-and-artifact-contract) — lifecycle hooks, Prometheus `/metrics`, run history, workspace quotas, per-harness secret scoping, artifact stores (local or dependency-free S3), and graceful drain.
7. [**Harness packs**](docs/DESIGN.md#7-harness-authoring-layers) — directories of markdown harnesses distributed via git / npm / tarball, installed with `agentbox add`, the way skill marketplaces work.
8. [**Scale-out**](docs/DESIGN.md#5-throughput-strategy) — a consistent-hash gateway pins sessions to nodes and fronts a fleet; copy-on-write workspace snapshots make session creation cheap.

Explore the [examples](examples) directory to see it in action, and the [design doc](docs/DESIGN.md) for details.

## Get started

Requires Node.js 20 or newer.

```sh
npm install @rlaope/agentbox
```

## Run your first harness

A harness declares how one task type runs. Register it, then `run` against a session — the same `(userId, goalId)` is reused warm on the next call.

```ts
import { Agentbox, defineHarness } from '@rlaope/agentbox';

const pptGenerate = defineHarness({
  name: 'ppt-generate',
  backend: 'claude',
  systemPrompt: 'Produce out/deck.pptx inside the workspace.',
  tools: { allow: ['Read', 'Write', 'Edit', 'Bash(node:*)'] },
  artifacts: { globs: ['out/**/*.pptx'] },
  limits: { maxTurns: 30, timeoutMs: 480_000 },
});

const box = new Agentbox({ maxConcurrentRuns: 8 });
box.register(pptGenerate);

const result = await box.run({
  session: { userId: 'u1', goalId: 'q2-deck' },
  harness: 'ppt-generate',
  prompt: 'A five-slide deck summarizing Q2 results',
});
console.log(result.artifacts); // [{ path: 'out/deck.pptx', ... }]
```

_(The claude / codex CLIs must be installed and authenticated on the host.)_

Or expose it over HTTP — runs stream back as SSE:

```sh
npx tsx examples/server.ts
curl -N localhost:8787/v1/runs -d '{
  "session": { "userId": "u1", "goalId": "q2-deck" },
  "harness": "ppt-generate",
  "prompt": "A five-slide deck summarizing Q2 results"
}'
```

## Authoring harnesses in markdown

TypeScript `defineHarness` is the escape hatch; markdown is the authoring format for the common case. A harness file is skill-shaped — YAML frontmatter for the spec, body as the system prompt:

```markdown
---
name: ppt-generate
backend: claude
tools: { allow: [Read, Write, "Bash(node:*)"] }
artifacts: [out/**/*.pptx]
limits: { maxTurns: 30, timeoutMs: 480000 }
---
You are a presentation-generation harness.
Produce exactly one file: out/deck.pptx.
```

```ts
await box.loadHarnessDir('./harnesses', { watch: true }); // one file = one task type, hot-reloaded
await box.loadHarnessPacks();                             // plus every installed pack
```

Distribute directories of them as packs:

```sh
npx agentbox add https://github.com/acme/office-pack   # git
npx agentbox add npm:@acme/office-pack                 # npm registry
npx agentbox add ./office-pack                         # local dir or .tgz
```

## Container isolation

When process-level isolation is not enough, plug in the docker provider and opt harnesses in with `sandbox: 'container'`. Each run executes in an ephemeral `docker run --rm` container with only its own workspace bind-mounted; a per-session home keeps resume state warm across containers.

```ts
import { Agentbox, ContainerSandboxProvider, startEgressProxy } from '@rlaope/agentbox';

const proxy = await startEgressProxy({ allowedDomains: ['api.anthropic.com', '*.npmjs.org'] });
const provider = new ContainerSandboxProvider('.agentbox/sessions', {
  image: 'my-agent-runner:latest',
  egressProxyUrl: proxy.url,       // agents reach only the allowlisted domains
  extraArgs: ['--memory', '2g', '--cpus', '2'],
});
await provider.warm();             // pre-pull the image so the first run skips pull latency

const box = new Agentbox({ sandboxProviders: [provider] });
```

Runs can be cancelled mid-flight — `box.cancel(runId)` or `DELETE /v1/runs/{runId}`.

## Multi-tenant & scale-out

Bind a key to a tenant so a leak exposes one tenant, not the fleet:

```ts
createHttpServer(box, {
  keys: [{ key: 'acme-key', userIds: ['acme-1', 'acme-2'], harnesses: ['ppt-generate'] }],
});
```

Front a fleet of single-node instances with a consistent-hash gateway that pins each session to its home node (SSE proxied through, lookups fanned out, stats aggregated):

```ts
import { createGatewayServer } from '@rlaope/agentbox';

createGatewayServer(
  [
    { id: 'node-1', url: 'http://10.0.0.5:8787' },
    { id: 'node-2', url: 'http://10.0.0.6:8787' },
  ],
  { apiKeys: ['client-key'], nodeApiKey: 'internal-key' },
).listen(8080);
```

Cut session creation cost with copy-on-write workspace snapshots — build the environment once, clone it per session:

```ts
await box.snapshots.create('deck-env',
  { seedFiles: { 'package.json': '…' } },
  { prepare: ['npm', 'install'] });
// harness: workspace: { snapshot: 'deck-env' }
```

## Observability

`GET /v1/stats` returns JSON (sessions, running/queued/active runs, totals by status, average duration); `GET /metrics` returns the same in Prometheus text format, scrapable without auth. Lifecycle hooks (`onRunStart` / `onEvent` / `onRunEnd`) feed any external tracer.

## Benchmarks

Framework overhead only — drivers are simulated, so this measures agentbox's scheduling, session management, state persistence, and artifact collection, not LLM latency. Reproduce with `npx tsx bench/throughput.mts` (Node 22, Apple M5).

| Scenario | Result |
|---|---|
| Pure overhead (0ms driver, 200 runs, 20 sessions, concurrency 8) | 8,514 runs/s; p50 14ms / p95 22ms per run including queue wait |
| Simulated agent (300ms driver, 200 runs, 40 sessions, concurrency 16) | 43.8 runs/s — 82% of the theoretical 53.3 runs/s ceiling |
| Burst fairness (1 heavy user's serialized session + 9 light users) | 100 runs, 0 failed, light users never starved |

## Development

```sh
npm install
npm run typecheck
npm test
```

Zero runtime dependencies; TypeScript, `tsx`, and `@types/node` are dev-only. Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Acknowledgements

agentbox sits one layer above the agent runtimes and sandbox infrastructure it orchestrates, and borrows ideas from the surrounding ecosystem:

- [Claude Code](https://code.claude.com/) & the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk) — the headless driver and the hook/middleware model
- [OpenAI Codex CLI](https://github.com/openai/codex) — the `exec --json` driver and kernel-level sandbox modes
- [pi](https://github.com/badlogic/pi-mono) — the embeddable, extension-based agent driver
- [E2B](https://e2b.dev/) & [Daytona](https://www.daytona.io/) — sandbox-infrastructure ideas (warm pools, snapshots, layered isolation)
- [Model Context Protocol](https://modelcontextprotocol.io/) — the custom-tool injection surface

## License

[MIT](LICENSE)
