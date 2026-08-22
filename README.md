# OZ Policy Builder

[![CI](https://github.com/untangledfinance/oz-policy-builder/actions/workflows/ci.yml/badge.svg)](https://github.com/untangledfinance/oz-policy-builder/actions/workflows/ci.yml)

The OZ Policy Builder turns a constraint you can say in a sentence into a
policy that lives on chain. You record a transaction and it produces a
predicate that an
[OpenZeppelin Stellar smart account](https://docs.openzeppelin.com/stellar-contracts)
enforces on every call. "This key may only call `transfer` on USDC, never
more than 50 at a time, and only to these three addresses" stops being a
promise and becomes something the account checks before it signs.

It is built as two halves:

- **Off chain**, `@crediolabs/policy-synth` records a transaction, lowers it to
  a predicate that pins the contract, method and arguments the recording
  carried, renders a review card describing every leaf, and returns an unsigned
  install transaction for the user's wallet to sign. A CLI and an MCP server
  wrap the same core for shells and agents.
- **On chain**, the `policy-interpreter` Soroban contract evaluates the
  predicate on every guarded call, fail-closed: one audit-once engine, and
  every policy is declarative data fed into it, so a new combination of
  constraints needs no new contract and no re-audit.

## What is actually running

The policy interpreter is deployed on Stellar mainnet and testnet, and both
pinned instances have been exercised end to end against real accounts: a policy
installed, the call it allows permitted, and the call it forbids denied by the
contract.

On mainnet, smart account
`CBASTKCV6RZFO6SPEBRFJJMAJ5FRCNYVERWX5I6QSRLE3YZ4X6OEVOAU` carries the
predicate `eq(call_fn, "transfer")` (hash `9c1b891f...`) installed at ledger
64066870. Its agent key `GD6SFD5C...` transferred at ledger 64066871; the same
key's `approve` on the same token was refused by the interpreter with
`#100 ArgMismatch`. The `approve` was given a valid expiration ledger first, so
the token had no reason of its own to reject it and the predicate is the only
thing that did.

The agent key sits on the policed rule and on no other, which is what makes
that a statement about the KEY rather than about one routing choice. A smart
account resolves a call against the rule the caller names, so a key that also
sat on the unpoliced admin rule could simply name that one and never reach the
predicate. The run proves the closure directly: the same forbidden call, routed
by the agent through the unpoliced rule, is rejected because the agent is not a
signer there. The admin key does retain full authority through that rule, by
design - a policy constrains the keys put under it, not the account's owner.

Reproduce either network with
`bun packages/policy-synth/scripts/e2e-network.ts --network testnet`; the
transcript of both runs is in
[docs/audit/evidence/e2e-network.log](./docs/audit/evidence/e2e-network.log).
Testnet funds itself through friendbot; mainnet needs a funded `--secret`.

The deployment is pinned in `packages/policy-synth/src/run/schemas.ts`:

| | Address / hash |
| --- | --- |
| Interpreter (mainnet) | `CBZXLSTQUITBFZHQH6XRXF3XIVRQR4RHRI64Q5WELS5KGY3ZKJPFWDPF` |
| Interpreter (testnet) | `CCL336TCK2Y5OFNRCMN2M3HVPBCEX4PW5H6EQ5VW5NPMXOCP4ESB5XR4` |
| Interpreter wasm sha256 | `a2b36e8ac5a61caf3757af26aa79e83f2995b451099f44772383806a55fe3414` |
| Grammar version | `3` |

The same wasm hash backs both networks; only the instance address differs.

> [!IMPORTANT]
> **Audit status.** The interpreter contract has not been externally audited.
> It has been through internal adversarial review, and an external review is
> in progress; no audit report has been published yet.
> [docs/architecture.md](./docs/architecture.md) is specific about what the
> policy layer does and does not enforce - treat anything it does not claim
> as unenforced. Report vulnerabilities per [SECURITY.md](./SECURITY.md).

## Where to start

| You want to | Read |
| --- | --- |
| Understand how the pieces fit together | [docs/architecture.md](./docs/architecture.md) |
| Build and install a policy from a shell | `packages/policy-builder-cli` (record + synthesize) |
| Drive it from an agent | `packages/policy-builder-mcp` (MCP over stdio / Streamable HTTP) |

## Layout

| Path | What it is |
| --- | --- |
| `packages/policy-synth` | The synthesiser and the record, verify, install and revoke flow. Published as `@crediolabs/policy-synth`. |
| `packages/policy-builder-cli` | CLI wrapper over the synth core (`@crediolabs/policy-builder-cli`). |
| `packages/policy-builder-mcp` | MCP server exposing the seven policy tools (`@crediolabs/policy-builder-mcp`). |
| `contracts/policy-interpreter` | The Soroban contract that enforces a predicate on chain. |
| `contracts/test-blend-pool` | A Blend-`submit`-shaped stub, for testnet verification only. |

## Build and test

The TypeScript workspace uses [Bun](https://bun.sh):

```sh
bun install
bun test          # unit + integration suites
bun run typecheck # tsc --noEmit across the three TS packages
bun run check     # biome lint + format
```

The Soroban contracts are standalone Cargo crates (soroban-sdk 27, built for
`wasm32v1-none`). There is no workspace manifest, so each is tested from its
own directory:

```sh
( cd contracts/policy-interpreter && cargo test )
( cd contracts/test-blend-pool    && cargo test )
```

## Contributing and security

[CONTRIBUTING.md](./CONTRIBUTING.md) is the short path from a fresh clone to
a green pull request; CI runs the same gates. Vulnerabilities go to
[SECURITY.md](./SECURITY.md), not the issue tracker. Package release notes
live in [CHANGELOG.md](./CHANGELOG.md), and the release procedure in
[docs/releasing.md](./docs/releasing.md).

## License

MIT. See [LICENSE](./LICENSE).
