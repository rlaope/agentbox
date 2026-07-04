## What

<!-- What does this PR change, and why? Link the related issue if one exists. -->

## Design contracts

<!-- Check that the change preserves the core contracts (see CONTRIBUTING.md): -->

- [ ] Session isolation: no framework API reads/writes outside a session's workspace root
- [ ] Runs within one session stay serialized; cross-session runs stay parallel
- [ ] Backend-specific behavior lives in drivers, not in the core
- [ ] Parsers ignore unrecognized backend output instead of failing the run

## Verification

<!-- How did you verify this? -->

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] Tests added/updated for behavioral changes
