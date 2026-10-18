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
  a review tree, and returns an unsigned install transaction for the user's
  wallet to sign. A CLI and an MCP server register the same eight tools from one
  table, for shells and agents.
- **On chain**, the `policy-interpreter` Soroban contract evaluates the
  predicate on every guarded call, fail-closed: one audit-once engine, and
  every policy is declarative data fed into it, so a new combination of
  constraints needs no new contract and no re-audit.

## What is running

The 2.x npm packages speak grammar 7 and pin a grammar-7 interpreter on
**testnet only** (`deployments/grammar7-testnet.json`; no mainnet instance yet,
so a mainnet install names its interpreter and has it verified live). The
grammar-4 instances the 1.x packages pinned, and the grammar-6 Prime ones, are
unchanged. The grammar-4 pair was exercised end to end against real accounts: a
policy installed, the call it allows permitted, and the call it forbids denied by
the contract.

On mainnet, smart account
`CAGAKEM3EVNJHUAXEAAKCY4LX4DVPR4EJ54R3U3DSDSG6B7JUOB6XU25` carries the
predicate `eq(call_fn, "transfer")` (hash `9c1b891f...`) on its rule 1,
installed at ledger 64151857. Its agent key `GALMSTGT...` transferred at ledger
64151858; the same key's `approve` on the same token was refused by the
interpreter with `#100 ArgMismatch`. The `approve` was given a valid expiration
ledger first, so the token had no reason of its own to reject it and the
predicate is the only thing that did. The same run passed on testnet.

The agent key sits on the policed rule and on no other, so the result holds for
the key whatever rule it names. A smart account resolves a call against the rule
the caller names, so a key that also sat on the unpoliced admin rule could name
that one and never reach the predicate. The run checks this directly: the same
forbidden call, routed by the agent through the unpoliced rule 0, is rejected
because the agent is no signer there. The admin key keeps full authority through
rule 0 by design. A policy constrains the keys put under it; the account's owner
stays in charge.

The transcript of both runs is in
[evidence/e2e-network.log](./evidence/e2e-network.log). The script that made it
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

**Install 2.0.1:**

```sh
npm install @crediolabs/policy-synth@next @stellar/stellar-sdk
npm install -g @crediolabs/policy-builder-cli@next   # the policy-builder command
npx -y @crediolabs/policy-builder-mcp@next           # the MCP server
```

The `latest` tag on npm is still 1.3.0 (grammar 4); `next` is 2.0.1 (grammar 7).

To run a checkout of this repo, build the packages in dependency order. The
package exports serve `src/` to Bun and `dist/` to Node, and `dist/` is not in
git:

```sh
bun install
bun run --cwd packages/policy-synth build
bun run --cwd packages/policy-builder-cli build
bun run --cwd packages/policy-builder-mcp build
node packages/policy-builder-cli/dist/bin/policy-builder.js info
node packages/policy-builder-mcp/dist/bin/server.js            # stdio
```

To use the checkout from another project, pack each package (`npm pack` builds
it first) and install the three tarballs together:

```sh
mkdir -p /tmp/opb
for p in policy-synth policy-builder-cli policy-builder-mcp; do
  (cd packages/$p && npm pack --pack-destination /tmp/opb)
done
cd /path/to/project && npm install /tmp/opb/crediolabs-*.tgz
```

**Superseded testnet interpreters:** three earlier grammar-7 instances are
still deployed on testnet, and the package refuses each of them by code hash
(`deployments/grammar7-testnet.json`):

| Address | Wasm | Why it was replaced |
| --- | --- | --- |
| `CDL7KHDKR7GZ2UN4P2XVJ63JTULNK3G5XKCE5NYKTMKKYONOAEKB3ZTB` | `eb1ec6ee...` | the first build: its `check` returned the verdict, so a submitted `check` could commit a read |
| `CA5ICI2OJAPYJKKOSFVPVKDR3YIJWDEZ6GPXYH2RPZ3BLWABPMYJAQAV` | `a975353d...` | limits compiled in, no `limits()` |
| `CAECFZWHHHKJRJHYR3EQHAMYHBQPW7G6BGKYSNJS4KLZAUNLQP7H5L2H` | `42d53616...` | `max_elems` could be 1, and the byte ceiling was 48 KiB |

The previous pin (1.x, grammar 4): mainnet
`CDN755TDYZM3ZQ5OXTJ6TIBUBWZV2KRI2BYJPBXD2MVWED4STT3VBN52`, testnet
`CCBHVZ6HGGV7C4SNHCZ3S5665Z2WEMHTMBAEPO4XW6PKON464BEBANU5`, wasm sha256
`b5ba1e35ccf20cd8c13c3a2c3098bf337033a92bcaf475d63c03ddc0cba0fcae`.

The Prime custody contracts went to mainnet on 1 October 2026 and the Prime app
at app.untangled.finance uses them: the grammar-6 interpreter
`CAOBQ4ZXANKXAGEJWJLIGQJDFCTHMEZVUPLPX277KSDMEU4MEWVVXO2R` and the custody gate
and execution adapter code (`b01024f3…`, `68d012e7…`), Linux builds recorded in
`deployments/prime-mainnet.json`. The adapter build `3dd675c0…`, which CI
rebuilds on `main` and on this branch, is uploaded on mainnet and testnet as
well, and new setups on both networks use it. Testnet's grammar-6 interpreter was built from the same source
without `build-wasm.sh`, so its hash differs. Addresses, hashes and transactions
are in [docs/stellar.md](./docs/stellar.md#deployments) and
[deployments/prime-mainnet.json](./deployments/prime-mainnet.json).

## What the 2.x tools check

The policy-synth README has the detail; the interpreter README has the
measurements behind the limits.

- **Limits are set at deploy time and never change:** each grammar-7 interpreter
  takes its `Limits` in its constructor, and `limits()` returns them. There is no
  setter and no upgrade. Each limit sits between a floor and a ceiling (reads 1
  to 8, leaves 4 to 400, bytes 256 to 40,960, elements 2 to 64, `in` entries 1 to
  64, depth 2 to 8), else the deploy fails with error 220.
- **Why 40 KiB:** an install transaction carries the predicate twice. At 40 KiB
  the install transaction as policy-synth builds it, with 15 operators and 16
  admins (the interpreter's maximum, one more admin than the tool accepts), is
  69% of the 132,096-byte transaction limit; 48 KiB was 82%.
- **Memory per transaction:** with 8 reads of wasm contracts, the first
  authorised context costs about 12.7 MB and each further one about 11.4 MB, so
  about 2 such contexts fit in one transaction inside an 80% margin.
- **Read targets must be kept alive,** and rent is paid per KB of rule: a permit
  near expiry extends the rule's entry inside the agent's own transaction.
- **Threshold:** an install with several signers needs a `threshold`
  (OpenZeppelin `simple_threshold` or `weighted_threshold`) that one signer
  cannot meet alone. Without one, any single signer could act alone; `anyOne`
  is the owners' override for that (see the next items but one).
- **Spending-limit guard:** a `spendingLimit` needs a rule that pins `transfer`
  on a token, because OpenZeppelin's `spending_limit` refuses every other call.
- **Read-safety lint:** a `read` outside the safe list (the testnet Reflector
  oracles and the operator's own list) is refused as `READ_UNSAFE`, unless the
  operator sets `POLICY_BUILDER_ALLOW_SPOT_READS=1`.
- **The full rule scan:** the install reads every live rule on the account and
  refuses a rule a shared signer could bypass.
- **Overrides belong to the owners:** `allowOverlap`, `allowUnboundedAmount`,
  `allowOpenSlippage`, `anyOne` and `allowAdminRule` each waive one refusal. No refusal
  names them, each one set comes back in `overrides` and opens the review, and
  on mainnet they are refused unless the operator sets
  `POLICY_BUILDER_ALLOW_OVERRIDES=1`.
- **Expiry and fee bounds:** the builder itself sets how long the signed
  transaction stays valid (`POLICY_BUILDER_AUTH_LEDGERS`, default 300 ledgers,
  with a time bound from the builder's clock) and refuses a resource fee above
  `POLICY_BUILDER_MAX_RESOURCE_FEE` (default 10 XLM).
- **The owner's review:** `review_unsigned` reads an unsigned install or
  removal from its bytes alone, with no RPC. It lists the problems it finds in
  the bytes (a shape the builder never makes, a digest that does not match, an
  interpreter other than the pin, a predicate whose hash does not match) and
  shows the authority the bytes grant. `signable` means no such problem; it does
  not mean safe. An agent can rewrite the bytes consistently, for example to
  make itself an admin, and they read signable, so the owner reads the Authority
  node against what they meant.
- **The authority header:** the install review opens with who may act, under
  which threshold, until when, up to what total, and under which interpreter.
  `[…]` marks the package's roles and `«…»` the labels given in the request.
- **Offline and live:** `synthesize_policy` from an intent works with no RPC,
  using the pin's recorded limits. `install_policy`, `verify_policy` and
  `simulate_policy` with calls always need the live interpreter; an
  explain-only `simulate_policy` needs it only when the network has a pin or
  the call gives `interpreterAddress`.

The STRIDE threat model for grammar 7, with what is done and what is open at
2.0.0, is [evidence/stride-threat-model-g7.md](./evidence/stride-threat-model-g7.md).

> [!IMPORTANT]
> **Audit status:** an external audit of the interpreter, custody gate
> and execution adapter contracts and the three npm packages is in progress,
> and its report is still to be published. The contracts have also been through internal adversarial
> review and STRIDE threat models.
> [docs/stellar.md](./docs/stellar.md) states what each contract enforces.
> Treat anything it does not claim as unenforced. Report vulnerabilities per
> [SECURITY.md](./SECURITY.md).

## Where to start

| You want to | Read |
| --- | --- |
| See what runs where, on every chain | [docs/README.md](./docs/README.md) |
| Understand the custody setup, the seats and how the chains fit together | [docs/architecture.md](./docs/architecture.md) |
| Read the Stellar contracts and the policy builder in detail | [docs/stellar.md](./docs/stellar.md) |
| Read the EVM design in detail | [docs/evm.md](./docs/evm.md) |
| Read the Solana programs in detail | [docs/solana.md](./docs/solana.md) |
| Read the NEAR signer in detail, and the status of the retired v1 | [docs/near.md](./docs/near.md) |
| Build and install a policy from a shell | `packages/policy-builder-cli` (`policy-builder <tool>`, all eight tools) |
| Drive it from an agent | `packages/policy-builder-mcp` (MCP over stdio / Streamable HTTP) |

## Layout

| Path | What it is |
| --- | --- |
| `packages/policy-synth` | The wire codec, the synthesiser and the record, simulate, verify, install and revoke tools. Published as `@crediolabs/policy-synth`. |
| `packages/policy-builder-cli` | One command per tool, registered from the synth core's table (`@crediolabs/policy-builder-cli`). |
| `packages/policy-builder-mcp` | MCP server exposing the eight policy tools (`@crediolabs/policy-builder-mcp`). |
| `contracts/stellar/policy-interpreter` | The Soroban contract that enforces a predicate on chain. |
| `contracts/stellar/custody-gate` | The custody account's gate: holds its allowance and releases only to listed addresses. |
| `contracts/stellar/execution-adapter` | The per-Prime batcher, bound to one gate. A batch can wait a number of ledgers before it runs. |
| `contracts/stellar/test-blend-pool` | A Blend-`submit`-shaped stub, for testnet verification only. |
| `contracts/stellar/prime-seat` | The seat of an owner who signs through NEAR, on a Prime account. It also serves the session keys that owner grants. |
| `contracts/{evm,solana,near}` | The EVM and Solana seats, the Solana custody gate and the NEAR signer v2 with its shared vectors. NEAR signer v1 left the tree on 18 October 2026; its testnet account still signs any payload until it is removed, and nothing in octopos calls it ([docs/near.md](./docs/near.md#prime-near-signer-v1-retired)). See [contracts/README.md](contracts/README.md). |
| `deployments/` | Deployment records that CI and the scripts read. |
| `evidence/` | Logs and receipts behind the claims in the docs. |

## Build and test

The TypeScript workspace uses [Bun](https://bun.sh):

```sh
bun install
bun run check           # biome lint + format
bun run --cwd packages/policy-synth build   # then policy-builder-cli, policy-builder-mcp
bun run typecheck       # tsc --noEmit across the three TS packages (needs the builds)
bun test                # every package's suites in one process
bun run test:isolated   # each package's tests alone
```

The Soroban contracts are standalone Cargo crates (soroban-sdk 27, built for
`wasm32v1-none`). There is no workspace manifest, so each is tested from its
own directory:

```sh
( cd contracts/stellar/policy-interpreter && ./build-wasm.sh && cargo test )
( cd contracts/stellar/custody-gate       && cargo test )
( cd contracts/stellar/execution-adapter  && cargo test )
( cd contracts/stellar/prime-seat         && cargo test )
( cd contracts/stellar/test-blend-pool    && cargo test )
```

The interpreter's `tests/worst_case.rs` loads the wasm that `build-wasm.sh`
writes. [CONTRIBUTING.md](./CONTRIBUTING.md) lists every gate CI runs.

## Contributing and security

[CONTRIBUTING.md](./CONTRIBUTING.md) is the short path from a fresh clone to
a green pull request; CI runs the same gates. Report vulnerabilities privately
through [SECURITY.md](./SECURITY.md). Package release notes
live in [CHANGELOG.md](./CHANGELOG.md), and the release procedure in
[CONTRIBUTING.md](./CONTRIBUTING.md#releasing).

## License

MIT. See [LICENSE](./LICENSE).
