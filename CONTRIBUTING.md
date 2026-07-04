# Contributing to agentbox

Thanks for your interest in contributing.

## Getting started

```sh
git clone https://github.com/rlaope/agentbox.git
cd agentbox
npm install
npm run typecheck
npm test
```

Node.js >= 20 is required. The project has zero runtime dependencies — please keep it that way unless there is a strong reason not to.

## Making changes

1. Fork the repo and create a branch from `main`.
2. Keep changes focused; one concern per PR.
3. Add or update tests under `test/` for anything behavioral. Tests use `node:test` and run via `tsx` — no real agent CLIs are required (use driver test doubles like `FakeDriver` in `test/agentbox.test.ts`).
4. Make sure `npm run typecheck` and `npm test` pass before opening the PR.

## Design constraints

These are the contracts the framework is built around — PRs should preserve them:

- **Session isolation**: a session's workspace is its trust boundary. Nothing may read or write outside its root through framework APIs.
- **Serialized runs per session**: concurrent runs within one session must stay serialized; cross-session runs stay parallel.
- **Backend neutrality**: drivers translate `HarnessSpec` into backend-native flags and normalize output into `RunEvent`s. Backend-specific behavior belongs in the driver, not in the core.
- **Defensive parsing**: backend CLI output formats change; parsers must ignore lines they do not recognize instead of failing the run.

Larger design context lives in [docs/DESIGN.md](docs/DESIGN.md). For substantial changes (new sandbox provider, new driver, scheduler changes), please open an issue to discuss the approach first.

## Reporting issues

Include the harness spec (redacted as needed), backend and CLI version, and the observed `RunEvent`/`RunResult` output where possible.
