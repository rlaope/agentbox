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

## Design constraints & working guidelines

The full contributor guide — architecture map, the design invariants PRs must preserve, how to add drivers/sandboxes/harness fields, working guidelines, and the quality bar — lives in [AGENTS.md](AGENTS.md). Larger design context is in [docs/DESIGN.md](docs/DESIGN.md).

For substantial changes (new sandbox provider, new driver, scheduler changes), please open an issue to discuss the approach first.

## Reporting issues

Include the harness spec (redacted as needed), backend and CLI version, and the observed `RunEvent`/`RunResult` output where possible.
