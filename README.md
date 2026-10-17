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

- **Off chain**, `@crediolabs/policy-synth` records a transaction or takes a
  declared mandate, turns it into a rule written in the predicate's own wire
  shape, verifies that rule through the interpreter's `check` (a dry run that always fails with its verdict), renders
  a review card, and returns an unsigned install transaction for the user's
  wallet to sign. A CLI and an MCP server register the same seven tools from one
  table, for shells and agents.
- **On chain**, the `policy-interpreter` Soroban contract evaluates the
  predicate on every guarded call, fail-closed: one audit-once engine, and
  every policy is declarative data fed into it, so a new combination of
  constraints needs no new contract and no re-audit.

## What is actually running

The 2.x npm packages speak grammar 7 and pin a grammar-7 interpreter on
**testnet only** (`deployments/grammar7-testnet.json`; no mainnet instance yet,
so a mainnet install names its interpreter and has it verified live). The
grammar-4 instances the 1.x packages pinned, and the grammar-6 Prime ones, are
unchanged. The grammar-4 pair was exercised end to end against real accounts: a
policy installed, the call it allows permitted, and the call it forbids denied by
the contract.

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

The transcript of that run is in
[evidence/e2e-network.log](./evidence/e2e-network.log); the script that made it
(`e2e-network.ts`) was written for the 1.x package API and is in git history at
`9c93592`.

The grammar-7 deployment the 2.x packages pin is in
`packages/policy-synth/src/config.ts`:

| | Address / hash |
| --- | --- |
| Interpreter (testnet, grammar 7) | `CDZV4AG46EDDLK5DZL2WY4C4XXNSRQWLAYIUI3ELS3XGPLUCECB3MPRT` |
| Interpreter wasm sha256 | `69cad1d5ce9aeaa0dad6980fd030e528935a0ebdd290111f393e9fd0564a68b0` |
| Its deploy-time limits | reads 8, leaves 400, bytes 24,576, elems 32, in 32, depth 5 (read from the instance with `limits()`; immutable) |
| Interpreter (mainnet) | none yet |
| Grammar version | `7` |

**Install 2.0.0:**

```sh
npm install @crediolabs/policy-synth@next
npm install @crediolabs/policy-builder-cli@next    # for the shell command
npm install @crediolabs/policy-builder-mcp@next    # for the MCP server
```

Or use unpublished versions from a checkout of this repo:

```sh
cd packages/policy-synth && npm link
cd ../policy-builder-cli && npm link @crediolabs/policy-synth && npm link  # repeat for policy-builder-mcp
```

The `latest` tag on npm is still 1.3.0 (grammar 4); `next` is 2.0.0 (grammar 7).

**Superseded testnet interpreters:**

The first grammar-7 testnet interpreter, `CA5ICI2OJAPYJKKOSFVPVKDR3YIJWDEZ6GPXYH2RPZ3BLWABPMYJAQAV` (wasm `a975353d...`, limits compiled in, no `limits()`), is superseded and no longer trusted by the package, and so is the second, `CAECFZWHHHKJRJHYR3EQHAMYHBQPW7G6BGKYSNJS4KLZAUNLQP7H5L2H` (wasm `42d53616...`: `max_elems` could be 1 and the byte ceiling was 48 KiB); both are refused by hash (`deployments/grammar7-testnet.json`).

The previous pin (1.x, grammar 4): mainnet
`CDN755TDYZM3ZQ5OXTJ6TIBUBWZV2KRI2BYJPBXD2MVWED4STT3VBN52`, testnet
`CCBHVZ6HGGV7C4SNHCZ3S5665Z2WEMHTMBAEPO4XW6PKON464BEBANU5`, wasm sha256
`b5ba1e35ccf20cd8c13c3a2c3098bf337033a92bcaf475d63c03ddc0cba0fcae`.

The Prime custody contracts went to mainnet on 1 October 2026 and the Prime app
at app.untangled.finance uses them: the grammar-6 interpreter
`CAOBQ4ZXANKXAGEJWJLIGQJDFCTHMEZVUPLPX277KSDMEU4MEWVVXO2R` and the custody gate
and execution adapter code (`b01024f3…`, `68d012e7…`). They are the Linux builds
that CI rebuilds and checks. Current testnet setups use the same gate and
adapter code. Testnet's grammar-6 interpreter was built from the same source
without `build-wasm.sh`, so its hash differs. Addresses, hashes and transactions
are in [docs/stellar.md](./docs/stellar.md#deployments) and
[deployments/prime-mainnet.json](./deployments/prime-mainnet.json).

> [!IMPORTANT]
> **Audit status.** An external audit of the interpreter, custody gate and
> execution adapter contracts is in progress, and its report has not been
> published yet. The contracts have also been through internal adversarial
> review and a STRIDE threat model.
> [docs/stellar.md](./docs/stellar.md) is specific about what each contract
> does and does not enforce - treat anything it does not claim as unenforced. Report vulnerabilities per [SECURITY.md](./SECURITY.md).

## Where to start

| You want to | Read |
| --- | --- |
| Understand the custody setup Prime uses, on Stellar and EVM | [docs/architecture.md](./docs/architecture.md) |
| Read the Stellar contracts and the policy builder in detail | [docs/stellar.md](./docs/stellar.md) |
| Read the EVM design in detail | [docs/evm.md](./docs/evm.md) |
| Build and install a policy from a shell | `packages/policy-builder-cli` (`policy-builder <tool>`, all seven tools) |
| Drive it from an agent | `packages/policy-builder-mcp` (MCP over stdio / Streamable HTTP) |

## Layout

| Path | What it is |
| --- | --- |
| `packages/policy-synth` | The wire codec, the synthesiser and the record, simulate, verify, install and revoke tools. Published as `@crediolabs/policy-synth`. |
| `packages/policy-builder-cli` | One command per tool, registered from the synth core's table (`@crediolabs/policy-builder-cli`). |
| `packages/policy-builder-mcp` | MCP server exposing the seven policy tools (`@crediolabs/policy-builder-mcp`). |
| `contracts/prime/stellar/policy-interpreter` | The Soroban contract that enforces a predicate on chain. |
| `contracts/prime/stellar/custody-gate` | The custody account's gate: holds its allowance and releases only to listed addresses. |
| `contracts/prime/stellar/execution-adapter` | The per-Prime batcher, bound to one gate. A batch can wait a number of ledgers before it runs. |
| `contracts/prime/stellar/test-blend-pool` | A Blend-`submit`-shaped stub, for testnet verification only. |
| `contracts/prime/stellar/prime-session` | The Stellar session signer for a Prime account. New code, in the audit scope. |
| `contracts/prime/{evm,solana,near}` | The PrimeX session contracts and the Solana custody gate. See [contracts/prime/README.md](contracts/prime/README.md). |
| `deployments/` | Deployment records that CI and the scripts read. |
| `evidence/` | Logs and receipts behind the claims in the docs. |

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
( cd contracts/prime/stellar/policy-interpreter && cargo test )
( cd contracts/prime/stellar/test-blend-pool    && cargo test )
```

## Contributing and security

[CONTRIBUTING.md](./CONTRIBUTING.md) is the short path from a fresh clone to
a green pull request; CI runs the same gates. Vulnerabilities go to
[SECURITY.md](./SECURITY.md), not the issue tracker. Package release notes
live in [CHANGELOG.md](./CHANGELOG.md), and the release procedure in
[CONTRIBUTING.md](./CONTRIBUTING.md#releasing).

## License

MIT. See [LICENSE](./LICENSE).
