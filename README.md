<p align="center">
  <img src="docs/assets/banner.png" alt="agentbox" width="100%" />
</p>

# agentbox

**The AI Agent Framework — Sandboxed Multi-Agent Orchestration, High-Throughput Stateful Agents, Modular Agent Session Manager & Runtime.**

agentbox lets a SaaS backend run coding agents (pi / codex / claude code) as its execution engine. A user request comes in through your API, agentbox acquires a session, runs the agent inside an isolated workspace with a task-specific harness, and returns the artifacts. Declare one harness per task type — PPT generation, document generation, bash script generation, anything an agent can build inside a workspace.

```
user → SaaS client → API call → agentbox
        └ acquire session (reused when warm)
          → run harness (codex / claude / pi)
          → collect & return artifacts
```

## Why

Running a general-purpose coding agent server-side is powerful but raises four problems at once:

1. **Isolation** — different users/projects must never touch each other's files.
2. **Throughput** — many concurrent sessions, and follow-up requests for the same unit of work should reuse an already-warm session instead of rebuilding context.
3. **Minimal tool surface** — an agent with every tool enabled is slower and riskier. "Generate a PPT" only needs file writes and `node`. Tool surface should be declared per task type.
4. **Pluggable backends** — the same harness should run on pi, codex, or claude code.

agentbox makes these four the core contract of the framework.

## Core concepts

- **Harness** — an execution profile for one task type: backend, model, system prompt, tool allowlist, workspace seed, artifact globs, turn/time limits.
- **Session** — one `(userId, goalId)` pair owning one workspace and per-backend resume state. Follow-up requests for the same pair are routed to the same warm session (claude `--resume`, codex `exec resume`).
- **Sandbox** — workspace isolation behind a provider interface. Process-level (`local`) by default; container/microVM providers plug in behind the same interface.
- **Driver** — a backend adapter that translates the harness declaration into backend-native flags and normalizes output streams into common run events.
- **FairScheduler** — a global concurrency cap plus per-user round-robin lanes, so one user's burst cannot starve everyone else.

See [docs/DESIGN.md](docs/DESIGN.md) for the full architecture.

## Usage

```ts
import { Agentbox, defineHarness } from 'agentbox';

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

Or run it as an HTTP server:

```sh
npx tsx examples/server.ts
curl -N localhost:8787/v1/runs -d '{
  "session": { "userId": "u1", "goalId": "q2-deck" },
  "harness": "ppt-generate",
  "prompt": "A five-slide deck summarizing Q2 results"
}'
```

Events stream back as SSE (`run:start`, `agent:message`, `tool:call`, `run:done`, …) so your client can render progress without knowing which backend is underneath.

## Markdown harnesses

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

Load a directory of them at boot — one markdown file is one task type:

```ts
await box.loadHarnessDir('./harnesses', { watch: true });
```

With `watch: true` the runtime hot-reloads: edits re-register, deletions unregister, and a mid-edit broken save keeps the previous registration in place. `name` defaults to the file basename.

## Development

```sh
npm install
npm run typecheck
npm test
```

Zero runtime dependencies; TypeScript, `tsx`, and `@types/node` are dev-only.

## Status

v0.2 — core runtime (local sandbox, three backend drivers, session manager, fair scheduler, HTTP/SSE facade) plus markdown harness authoring with hot reload. Container provider and pi programmatic tool control are on the [roadmap](docs/DESIGN.md#11-roadmap).

## Contributing

Issues and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
