# Contributor & Agent Guide

This is the canonical working guide for humans and AI agents contributing to agentbox. It covers how the codebase is structured, the invariants that must hold, how to add features cleanly, and the quality bar for merging. `CLAUDE.md` points here.

agentbox is a **server-side framework for running coding agents (pi / codex / claude) as a SaaS backend's execution engine**. Read [docs/DESIGN.md](docs/DESIGN.md) before non-trivial work — it is the source of truth for architecture and rationale.

## Architecture map

The core owns primitives only; task-specific behavior lives in harnesses and drivers.

```
src/
  agentbox.ts          orchestrator: run lifecycle, retries, hooks, history, metrics
  types.ts             every shared interface (the contract surface)
  harness/             registry, markdown authoring (yaml.ts, markdown.ts)
  session/             SessionManager: (userId, goalId) → workspace, serialization, TTL
  scheduler/           FairScheduler: concurrency cap, per-user lanes, backpressure
  sandbox/             local + container providers, snapshots, shared seedWorkspace
  drivers/             CliDriver base + pi / codex / claude adapters
  artifacts/           ArtifactStore: local archive, S3 (dependency-free SigV4)
  packs/               harness pack install (git / npm / tarball / local)
  cluster/             ConsistentHashRouter + multi-node gateway
  metrics/             Prometheus text-format exposition
  server/              HTTP/SSE facade, auth, egress proxy
  cli.ts               `agentbox add/list/remove`
```

## Design contracts (invariants)

Every change must preserve these. A PR that weakens one needs an explicit, argued reason.

1. **Zero runtime dependencies.** `package.json` has devDependencies only. Reach for the Node stdlib before adding a dep; if a dep seems unavoidable, open an issue first.
2. **Session isolation.** A session's workspace is its boundary. No framework API reads or writes outside its root; `LocalSandbox` path-checks every write. Different sessions never share files.
3. **Serialized runs per session.** Concurrent runs in one session stay serialized (arrival order); cross-session runs stay parallel. This is what makes lock-free file access safe.
4. **Backend neutrality.** Drivers translate `HarnessSpec` into backend-native flags and normalize output into `RunEvent`s. Backend-specific behavior lives in the driver, never in the core.
5. **Defensive parsing.** Backend CLI output formats drift; parsers ignore lines they don't recognize rather than failing a run.
6. **Observability never breaks a run.** Hook exceptions are swallowed; a metrics or artifact-store concern must not crash the run loop (an artifact-store *failure* is a deliberate exception — losing durable copies is loud).

## Adding features

- **A new backend driver** → extend `CliDriver`, implement `invocation()` (+ optional `beforeRun()`, `onLine()`), register it in `Agentbox`'s driver map. Map the harness's tool policy onto that backend's real flags. Verify against the real CLI, not just a test double.
- **A new sandbox provider** → implement `SandboxProvider`/`Sandbox` (including `wrapCommand`, `usage`, `seedWorkspace` via the shared helper). The workspace stays a host directory; only execution crosses the boundary.
- **A new harness field** → add it to `HarnessSpec` in `types.ts`, thread it through the driver(s) that consume it, and add it to the markdown frontmatter parser in `harness/markdown.ts` so both authoring layers stay in sync.
- **Prefer markdown-authored harnesses** for task types; reserve TypeScript `defineHarness` for the ~20% that declaration can't express.

## Working guidelines

Biased toward caution over speed (adapted from [Karpathy's LLM-coding guidelines](https://github.com/multica-ai/andrej-karpathy-skills)). Use judgment on trivial tasks.

- **Think before coding.** State assumptions; if multiple interpretations exist, surface them instead of picking silently. If something is unclear, stop and ask.
- **Simplicity first.** The minimum code that solves the problem — no speculative abstractions, config, or error handling for impossible cases. If 200 lines could be 50, rewrite.
- **Surgical changes.** Touch only what the task requires. Don't reformat or refactor adjacent code, and match existing style. Remove only the orphans *your* change created; mention pre-existing dead code rather than deleting it.
- **Goal-driven, verified.** Turn a task into a checkable goal ("fix the bug" → "write a failing test, then make it pass"). Every changed line should trace to the request.

## Quality bar (before opening a PR)

```sh
npm run typecheck    # tsc --noEmit, strict
npm test             # node:test via tsx; 80+ tests, all must pass
npm run build        # dist emit must succeed (prepublishOnly runs all three)
```

- **Add or update tests** for any behavioral change. Use driver test doubles (see `test/agentbox.test.ts`) — real CLIs are not required for the suite, but verify new drivers/sandboxes against the real thing manually and note it in the PR.
- **Flaky tests are bugs.** If a test depends on timing, gate it on a condition (`waitFor`), not a fixed sleep.
- **No fake completion.** `test.skip`/`.only`, stub tests, TODO placeholders, and unimplemented branches are blockers, not progress.

## Releases & conventions

- **Semver.** Breaking changes to the public API (`src/index.ts` exports) are major bumps. Update `CHANGELOG.md` and `package.json` version together.
- **Docs travel with code.** A feature isn't done until `docs/DESIGN.md`, the README, and the CHANGELOG reflect it. Keep design-doc anchors stable — the README links into them.
- **Commit & PR messages** describe what changed and why, in the imperative. Use the [PR template](.github/PULL_REQUEST_TEMPLATE.md) checklist. **Never** add AI/Claude/Generated-with attribution or Co-Authored-By trailers to commits or PR bodies.
- **CI must be green** (typecheck + test + build on Node 20 & 22) before merge.
