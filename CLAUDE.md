# CLAUDE.md

Guidance for Claude Code (and other coding agents) working in this repository.

**Read [AGENTS.md](AGENTS.md) first** — it is the canonical contributor and agent guide: architecture map, design contracts (invariants), how to add features, working guidelines, quality bar, and release conventions.

Quick reference:

- **What this is**: a zero-dependency, server-side framework for running coding agents (pi / codex / claude) as a SaaS backend's execution engine. See [docs/DESIGN.md](docs/DESIGN.md) for architecture.
- **Before merging**: `npm run typecheck && npm test && npm run build` must all pass; CI is green on Node 20 & 22.
- **Never** put AI/Claude/Generated-with attribution or `Co-Authored-By` trailers in commit messages or PR bodies.
- **Preserve the invariants** in AGENTS.md (session isolation, serialized runs, backend neutrality, zero deps, defensive parsing, observability never breaks a run).
- **Keep changes surgical** and docs in sync (DESIGN.md ↔ README ↔ CHANGELOG).
