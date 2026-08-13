# Releasing

## npm packages

`@crediolabs/policy-synth`, `@crediolabs/policy-builder-cli` and
`@crediolabs/policy-builder-mcp` version together: one release bumps all
three to the same version, because the CLI and the MCP server pin the synth
core to an exact version (no `^` range).

1. Bump `version` in all three `package.json` files, and the
   `@crediolabs/policy-synth` dependency pin in
   `packages/policy-builder-cli/package.json` and
   `packages/policy-builder-mcp/package.json`, to the same new version.
2. Move the `[Unreleased]` entries in [CHANGELOG.md](../CHANGELOG.md) under
   the new version heading.
3. Commit as `chore(release): vX.Y.Z` and make sure CI is green.
4. Publish in dependency order; `prepublishOnly` builds and tests each
   package as part of the publish:

   ```sh
   ( cd packages/policy-synth       && npm publish --access public )
   ( cd packages/policy-builder-cli     && npm publish --access public )
   ( cd packages/policy-builder-mcp     && npm publish --access public )
   ```

5. Verify: `npm view @crediolabs/policy-synth version` returns the new
   version, and the package page renders the README.
6. Tag the release commit: `git tag vX.Y.Z && git push origin vX.Y.Z`.
7. Bump the pin in downstream consumers (internal applications pin
   `@crediolabs/policy-synth` to an exact version).

Publishing is deliberately manual. CI has no npm credentials and no publish
job; keep it that way unless the token handling story changes.

## Contracts

The Rust crates are `publish = false`: they are never released to
crates.io. A contract "release" is a deployment:

- The policy interpreter's live addresses and wasm sha256 are pinned in
  `packages/policy-synth/src/run/schemas.ts`. Deploying a new interpreter
  build means a new wasm hash, new instance addresses, updating those pins,
  and releasing the npm packages that carry them.
- A predicate grammar change additionally bumps `SELF_VERSION`
  (`contracts/policy-interpreter/src/version.rs`) and regenerates the
  conformance fixtures; `install` refuses a grammar version it does not
  speak, so old synthesisers cannot install onto a new interpreter.
