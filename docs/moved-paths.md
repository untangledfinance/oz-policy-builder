# Earlier paths

Paths that earlier documents and links name, and where each is now. A path
marked "link" is a symbolic link to the current location, so the old address
opens the current file or folder. A path marked "file" holds a copy that was put
back as a dated record. The commits are in this repository's history.

| Earlier path | Now | What the earlier path is | Commit | Date |
|---|---|---|---|---|
| `docs/stride-threat-model.md` | [`evidence/stride-threat-model.md`](../evidence/stride-threat-model.md) | link | `fa12323` removed it, `288ddfa` wrote the current file | 2026-09-29 |
| `docs/audit/evidence/` | [`evidence/`](../evidence) | link; six logs have no current file (below) | `fa12323` | 2026-09-29 |
| `docs/devlog/2026-08.md` | [`docs/devlog/2026-08.md`](devlog/2026-08.md) | file, the post as it stood; the same text is in [Discussions #2](https://github.com/untangledfinance/oz-policy-builder/discussions/2) | added `08f60cb`, removed `fa12323` | 2026-08-28, 2026-09-29 |
| `scripts/upstream-drift-check.ts` | [`packages/policy-synth/scripts/upstream-drift-check.ts`](../packages/policy-synth/scripts/upstream-drift-check.ts) | link; the script was added under `packages/policy-synth/scripts/` and has not been at the root `scripts/` | `a2257d4` | 2026-08-28 |
| `packages/policy-builder-mcp/postman/` | [`packages/policy-builder-mcp/postman/`](../packages/policy-builder-mcp/postman) | file, a collection written for the nine tools of 5.2.0, with a README; the collection of the 1.x releases is at [commit `3841372`](https://github.com/untangledfinance/oz-policy-builder/blob/3841372/packages/policy-builder-mcp/postman/oz-policy-builder-mcp.postman_collection.json) | added `9ddeb1a`, removed `920a18f` | 2026-08-28, 2026-10-21 |
| `apps/policy-builder-cli` | [`packages/policy-builder-cli`](../packages/policy-builder-cli) | link; this repository has had `packages/` since its first commit | `da568de` | 2026-08-13 |
| `apps/policy-builder-mcp` | [`packages/policy-builder-mcp`](../packages/policy-builder-mcp) | link; as above | `da568de` | 2026-08-13 |
| `packages/policy-interpreter` | [`contracts/stellar/policy-interpreter`](../contracts/stellar/policy-interpreter) | link; the contract has always been under `contracts/`, and being Rust it has no `package.json`, so it is not a workspace package | `da568de` | 2026-08-13 |
| `contracts/policy-interpreter` | [`contracts/stellar/policy-interpreter`](../contracts/stellar/policy-interpreter) | moved, no link | `920a18f` | 2026-10-21 |
| `packages/policy-synth/src/synth/deny-cases.ts` | `denyCases` in [`packages/policy-synth/src/check.ts`](../packages/policy-synth/src/check.ts), tested in [`check.test.ts`](../packages/policy-synth/src/check.test.ts) | removed; the file at its last commit is [here](https://github.com/untangledfinance/oz-policy-builder/blob/6bd4895/packages/policy-synth/src/synth/deny-cases.ts) | `50a2aa4` removed it, `b1f83b9` wrote `check.ts` | 2026-08-21, 2026-10-15 |

## Logs under `docs/audit/evidence/` with no current file

`evidence/` holds the logs that match the current tree. These six did not carry
over. Each is at the last commit that had it, `d89e17b`.

| Log | At `d89e17b` |
|---|---|
| `contract-gate-recheck-e2d2a95.log` | [open](https://github.com/untangledfinance/oz-policy-builder/blob/d89e17b/docs/audit/evidence/contract-gate-recheck-e2d2a95.log) |
| `e2e-network.log` | [open](https://github.com/untangledfinance/oz-policy-builder/blob/d89e17b/docs/audit/evidence/e2e-network.log) |
| `oz-policy-composition.log` | [open](https://github.com/untangledfinance/oz-policy-builder/blob/d89e17b/docs/audit/evidence/oz-policy-composition.log) |
| `oz-spending-limit-binding.log` | [open](https://github.com/untangledfinance/oz-policy-builder/blob/d89e17b/docs/audit/evidence/oz-spending-limit-binding.log) |
| `oz-threshold-binding.log` | [open](https://github.com/untangledfinance/oz-policy-builder/blob/d89e17b/docs/audit/evidence/oz-threshold-binding.log) |
| `oz-two-rule-blend-cap.log` | [open](https://github.com/untangledfinance/oz-policy-builder/blob/d89e17b/docs/audit/evidence/oz-two-rule-blend-cap.log) |
