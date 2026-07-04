# Changelog

All notable changes to agentbox are documented here. Versions follow semver.

## 1.1.0

Benchmark-driven refinements (reviewed by an architect pass before implementation).

- **Per-run tool count**: `RunResult.toolCalls` reports how many tool calls the agent made, counted centrally from the event stream (backend-neutral, no driver changes). Lets operators tune per-harness tool allowlists.
- **Parallel gateway fan-out**: `/v1/stats` and `/v1/runs` aggregate across nodes with `Promise.allSettled` (a dead node degrades to partial results instead of failing the whole response); run lookups take the first non-404 across nodes concurrently instead of sequentially.
- **Opt-in quota excludes**: `limits.workspaceQuotaExcludes` skips named directories (e.g. `node_modules`) from the `maxWorkspaceBytes` walk. The default still counts the whole workspace — skipping was made explicit rather than a silent default, so the quota keeps bounding real disk usage unless the operator opts out.

## 1.0.0

First stable release. The full framework surface — every roadmap feature shipped — with the claude and codex drivers verified end-to-end against the real CLIs and the container sandbox and egress proxy verified against a real docker daemon.

- **Metrics export**: `GET /metrics` in Prometheus text format (`renderPrometheus`), scrapable without auth.
- **Container image warm pool**: `ContainerSandboxProvider.warm()` pre-pulls the run image so the first run skips pull latency.

## 0.9.0

- Domain-allowlist egress control for container runs (`startEgressProxy`, `egressProxyUrl`), verified against real docker.
- Per-key tenant binding on the HTTP facade (`keys: [{ key, userIds, harnesses }]`).

## 0.8.0

- Multi-node scale-out: `ConsistentHashRouter` + `createGatewayServer` (session→node affinity, SSE proxying, fan-out lookups, aggregated stats).
- Copy-on-write workspace snapshots (`SnapshotManager`, `workspace.snapshot`).

## 0.7.0

- HTTP facade API-key auth and run history (`GET /v1/runs`, `GET /v1/runs/{id}`).
- Resume-state persistence across restarts; session pre-warming (`prewarmSessions`).
- Framework throughput benchmark; real-docker container verification.

## 0.6.0

- Real-CLI verification of the claude/codex drivers (warm resume included).
- pi driver on the verified flag surface; MCP injection for codex.
- Artifact stores (local archive + dependency-free S3/SigV4); npm/tarball pack sources.

## 0.5.0

- Harness packs: git/local distribution with `agentbox add/list/remove` CLI and `loadHarnessPacks()`.

## 0.4.0

- Operations layer: backpressure, per-user caps, retries, lifecycle hooks, metrics, workspace quotas, per-harness secret scoping, MCP injection for claude, graceful drain.

## 0.3.0

- Docker container isolation (`ContainerSandboxProvider`); run cancellation.

## 0.2.0

- Markdown harness authoring with hot reload (`loadHarnessDir`).

## 0.1.0

- Core runtime: sessions, fair scheduler, local sandbox, pi/codex/claude drivers, HTTP/SSE facade.
