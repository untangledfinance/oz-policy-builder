## Summary

<!-- What this changes and why, in a few sentences. -->

## Verification

<!-- Check what you ran locally. CI runs all of these. -->

- [ ] `bun run check` (biome)
- [ ] `bun run typecheck`
- [ ] `bun test`
- [ ] `cargo fmt --check` + `cargo test` in each touched crate
- [ ] Conformance suite, if the predicate encoder or grammar changed
      (`cargo test --release --test conformance` + regenerated fixtures)

## Invariants

<!-- If this touches a contract: which documented invariants or hard-rules
     blocks did you read, and why is the change compatible with them?
     Delete this section for off-chain-only changes. -->
