## What

<!-- What does this PR change, and why? Link the related issue if one exists. -->

## Design contracts

<!-- Check that the change preserves the invariants in AGENTS.md: -->

- [ ] Zero runtime dependencies (devDependencies only)
- [ ] Session isolation: no framework API reads/writes outside a session's workspace root
- [ ] Runs within one session stay serialized; cross-session runs stay parallel
- [ ] Backend-specific behavior lives in drivers, not in the core
- [ ] Parsers ignore unrecognized backend output instead of failing the run
- [ ] Observability (hooks/metrics) never crashes the run loop

## Verification

<!-- How did you verify this? -->

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run build` passes
- [ ] Tests added/updated for behavioral changes
- [ ] New driver/sandbox verified against the real CLI/daemon (note how, if applicable)

## Docs

- [ ] `docs/DESIGN.md`, `README.md`, and `CHANGELOG.md` updated if behavior or the public API changed
