# Changelog

All notable changes to agentbox are documented here. Versions follow semver.

## Unreleased

Four capabilities that make a run more than fire-and-forget, built on top of agentbox's sandbox ownership. Implemented with an adversarial multi-agent review pass that surfaced and fixed real defects before merge (fail-open guardrail regex, guardrail-after-upload ordering, verify running outside the session lock, unguarded event sink, pipeline error handling).

- **Execution-based verification** (`harness.verify`): after a successful run, run a check *inside the sandbox* against the produced artifacts (run the script, lint, open the file). Non-zero exit fails the run unless `required: false`; result on `RunResult.verification`. Runs inside the session lock so a concurrent same-session run can't corrupt the check.
- **Guardrails** (`harness.guardrails.input/output`): validation functions gating a run's input and output. Input blocks prevent the run from spawning; output blocks run before artifact-store upload. Throwing fails closed. `denyOutputPatterns` built-in is stateless across runs (resets regex `lastIndex`).
- **Pipelines** (`box.runPipeline`): run a sequence of harnesses in one session sharing the workspace (generate → verify → refine), stopping at the first non-succeeded step. Harness names are validated up front; a mid-pipeline throw returns a failed result rather than discarding completed steps.
- **Human-in-the-loop** (`requireApproval` + `approvePipeline`/`rejectPipeline`): a pipeline step can pause for approval and resume later. Pending state is in-memory and cleared on `close()`.

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
