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
  wallet to sign. A CLI and an MCP server register the same nine tools from one
  table, for shells and agents.
- **On chain**, the `policy-interpreter` Soroban contract evaluates the
  predicate on every guarded call, fail-closed: one audit-once engine, and
  every policy is declarative data fed into it, so a new combination of
  constraints needs no new contract and no re-audit.

## What is in this repository

| Component | Path | Size (sLOC) |
| --- | --- | --- |
| Policy interpreter | `contracts/stellar/policy-interpreter` | 881 |
| Execution adapter | `contracts/stellar/execution-adapter` | 277 |
| Custody gate | `contracts/stellar/custody-gate` | 53 |
| Prime seat | `contracts/stellar/prime-seat` | 97 |
| Policy synthesiser | `packages/policy-synth` | 4,818 |
| CLI | `packages/policy-builder-cli` | 76 |
| MCP server | `packages/policy-builder-mcp` | 133 |
| EVM seat, `PrimeSeat` | `contracts/evm/prime-seat` | 72 |
| Solana custody gate | `contracts/solana/custody-gate` | 126 |
| Solana seat, `prime-seat` | `contracts/solana/prime-seat` | 75 |

The EVM and Solana contracts are on test networks only and outside the
external audit. The EVM seat is fork-tested against Base Sepolia and has no
persistent deployment ([deployments/evm-testnet.json](./deployments/evm-testnet.json));
the Solana programs are deployed on devnet
([deployments/solana-devnet.json](./deployments/solana-devnet.json)).
[SECURITY.md](./SECURITY.md#scope) lists the scope for reports, all three
chains included.

[docs/audit-overview.md](./docs/audit-overview.md) gives the external audit's
scope (the Stellar contracts and the packages), the counting method with a command to reproduce it, and the properties each
contract enforces.

The packages pin one interpreter instance on testnet (`packages/policy-synth/src/config.ts`):

| | Address / hash |
| --- | --- |
| Interpreter (testnet) | `CDER6P73JWMIVD3X6TGGOQIDAH3DLU7OKRTLT4ULPTZ3QJJ3QUGTK7CM` |
| Its wasm sha256 | `6704996f626904a4e33b95bda17b73963fc9cf502ffdfdbe9d85b4b10288e0d4` |
| Its deploy-time limits | reads 8, leaves 400, bytes 24,576, elems 32, in 32, depth 5 (read from the instance with `limits()`; immutable) |

The pinned instance runs this tree's interpreter source (`6704996f…`,
`contracts/build-hashes.json`). It replaced `CD46LN75…`, which runs `810f53f1…`
(this source before referenced rules and the batch pin), and that one replaced
`CDZV4AG4…`, which runs `69cad1d5…` (before the keyless executor rules). The
packages trust neither earlier build (`deployments/interpreter-testnet.json`
lists both as superseded).

The current release, and the code submitted for the external audit, is this
repository at tag `v5.2.0`; the audit started on 26 October 2026 and is in
progress. The contracts are unchanged from `v5.1.0` (interpreter `6704996f…`,
adapter `bf85432c…`); `v5.2.0` adds to `policy-synth` the signing for
OpenZeppelin's 0.8.0 account (`8286422f…`) beside the 0.7.2-line one, and moves
the testnet OpenZeppelin policies to `v0.8.0` builds
([audit-overview](./docs/audit-overview.md#in-scope-and-out-of-scope) has the
scope). It is published to npm at version 5.2.0 as `@crediolabs/policy-synth`,
`@crediolabs/policy-builder-cli` and `@crediolabs/policy-builder-mcp`:

```sh
npm install @crediolabs/policy-synth@5.2.0 @stellar/stellar-sdk
npm install -g @crediolabs/policy-builder-cli@5.2.0     # the policy-builder command
npx -y @crediolabs/policy-builder-mcp@5.2.0             # the MCP server over stdio
```

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

**Shared rules, and a trust note (E-38).** A rule of one account may *follow*
another account's rule instead of carrying its own predicate: it reads the
followed rule's predicate live at `enforce`, and the owner of the followed rule
changes it by their own normal two-party re-install, with no action by the
follower. Only the predicate is shared; the follower's signers, binding, nonce
and authorisation stay its own. This is deliberate, so an issuer can govern a
borrower's fence. The trust assumption to know: if the following rule is
**keyless** and bound to an adapter with no gate, that predicate is its *entire*
fence, and the followed owner can loosen it alone, after which anyone who
satisfies it moves the follower's funds. This is the intended
issuer-governed-keyless pattern, not a bug and not refused on chain; it is
flagged by a `policy-synth` warning (release `v5.1.0`, which adds only that
warning — the contracts are unchanged from `v5.0.0`) and documented as finding
E-38 in [docs/audit-overview.md](./docs/audit-overview.md) and the
[threat model](./evidence/stride-threat-model.md) (section 6.8, with the
testnet proof in 7.2). A **keyed** follower is unaffected.

## What the tools check

The policy-synth README has the detail; the interpreter README has the
measurements behind the limits.

- **Limits are set at deploy time and never change:** each interpreter instance
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
  names them, and each one set comes back in `overrides` and opens the review.
  Outside testnet they are refused unless the operator sets
  `POLICY_BUILDER_ALLOW_OVERRIDES=1`.
- **Expiry and fee bounds:** the builder itself sets how long the signed
  transaction stays valid (`POLICY_BUILDER_AUTH_LEDGERS`, default 300 ledgers,
  with a time bound from the builder's clock) and refuses a resource fee above
  `POLICY_BUILDER_MAX_RESOURCE_FEE` (default 10 XLM).
- **The owner's review:** `review_unsigned` reads an unsigned install,
  removal or binding from its bytes alone, with no RPC. It lists the problems it
  finds in the bytes (a shape the builder never makes, a `__check_auth`
  digest or 0.8.0 preimage that does not match, an interpreter other than the
  pin, a predicate whose hash does not match) and
  shows the authority the bytes grant. `signable` means no such problem; it does
  not mean safe. An agent can rewrite the bytes consistently, for example to
  make itself an admin, and they read signable, so the owner reads the Authority
  node against what they meant.
- **Contract signers:** the install reads each contract signer off the ledger
  and refuses an execution adapter bound to no gate, an execution adapter
  signing a rule scoped to itself that does not pin `call_fn = run`, or a
  contract that is not deployed. Every other contract passes unvetted, so the
  owner checks who controls it.
- **The authority header:** the install review opens with who may act, under
  which threshold, until when, up to what total, and under which interpreter.
  `[…]` marks the package's roles and `«…»` the labels given in the request.
- **Offline and live:** `synthesize_policy` from an intent works with no RPC,
  using the pin's recorded limits. `install_policy`, `verify_policy` and
  `simulate_policy` with calls always need the live interpreter; an
  explain-only `simulate_policy` needs it only when the network has a pin or
  the call gives `interpreterAddress`.

> [!IMPORTANT]
> **Audit status:** an external audit of the interpreter, the custody gate, the
> execution adapter, the Prime seat and the three TypeScript packages in this repository, at
> tag `v5.2.0`, is in progress; its scope is in
> [docs/audit-overview.md](./docs/audit-overview.md). The contracts have also
> been through internal adversarial review and STRIDE threat models, indexed in
> [evidence/README.md](./evidence/README.md).
> [docs/stellar.md](./docs/stellar.md) states what each contract enforces.
> Treat anything it does not claim as unenforced. Report vulnerabilities per
> [SECURITY.md](./SECURITY.md).

## Where to start

| You want to | Read |
| --- | --- |
| Audit the code | [docs/audit-overview.md](./docs/audit-overview.md) |
| See what runs where | [docs/README.md](./docs/README.md) |
| Understand the custody setup and the Prime seats | [docs/architecture.md](./docs/architecture.md) |
| Read the Stellar contracts and the policy builder in detail | [docs/stellar.md](./docs/stellar.md) |
| Read the EVM or Solana design | [docs/evm.md](./docs/evm.md), [docs/solana.md](./docs/solana.md) |
| Build and install a policy from a shell | `packages/policy-builder-cli` (`policy-builder <tool>`, all nine tools) |
| Drive it from an agent | `packages/policy-builder-mcp` (MCP over stdio / Streamable HTTP) |

## Layout

| Path | What it is |
| --- | --- |
| `packages/policy-synth` | The wire codec, the synthesiser and the nine tools (record, synthesize, simulate, verify, install, revoke, bind, info, review). Packaged as `@crediolabs/policy-synth`. |
| `packages/policy-builder-cli` | One command per tool, registered from the synth core's table (`@crediolabs/policy-builder-cli`). |
| `packages/policy-builder-mcp` | MCP server exposing the nine policy tools (`@crediolabs/policy-builder-mcp`). |
| `contracts/stellar/policy-interpreter` | The Soroban contract that enforces a predicate on chain. |
| `contracts/stellar/custody-gate` | The custody account's gate: holds its allowance and releases only to listed addresses. |
| `contracts/stellar/execution-adapter` | The per-Prime batcher, bound to one gate or to none. With a gate, a batch can wait a number of ledgers before it runs. |
| `contracts/stellar/test-blend-pool` | A Blend-`submit`-shaped stub, for testnet verification only. |
| `contracts/stellar/prime-seat` | The Prime seat: an owner's seat on a Prime account, held by an ed25519 owner key, and the session keys that owner grants. |
| `contracts/evm/prime-seat` | `PrimeSeat`, the EVM seat: a Safe owner for one seat owner, held by a secp256k1 owner key (Foundry). |
| `contracts/solana/custody-gate` | The Solana custody gate: owns custody's dedicated token account and pays only listed destinations or the recovery address. |
| `contracts/solana/prime-seat` | The Solana seat program: a seat PDA in a Squads Smart Account, held by an ed25519 owner key. |
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
( cd contracts/stellar/execution-adapter  && ./build-wasm.sh && cargo test )
( cd contracts/stellar/policy-interpreter/oz08 && cargo test --locked )   # needs both builds above
( cd contracts/stellar/custody-gate       && cargo test )
( cd contracts/stellar/prime-seat         && cargo test )
( cd contracts/stellar/test-blend-pool    && cargo test )
```

The interpreter's `tests/worst_case.rs` and the `oz08/` suite load the wasm that
`build-wasm.sh` writes; `oz08/` runs it against OpenZeppelin's 0.8.0 account
in a soroban-sdk 28 host, and its `tests/nogate.rs` also loads the wasm the
execution adapter's `build-wasm.sh` writes.

The EVM seat builds with Foundry 1.8.4 and the Solana programs with the Solana
CLI 4.3.0 (`cargo-build-sbf`):

```sh
( cd contracts/evm/prime-seat && forge build && FORK_URL=https://sepolia.base.org forge test )   # after unpacking OpenZeppelin 5.4.0 into lib/oz
( cd contracts/solana/prime-seat && PRIME_CLUSTER=devnet cargo test && PRIME_CLUSTER=localnet cargo-build-sbf -- --locked )
( cd contracts/solana/custody-gate && cargo test --locked && PRIME_CLUSTER=localnet cargo-build-sbf -- --locked )
```

[contracts/README.md](./contracts/README.md) has the tool versions and the
recorded hashes, and [CONTRIBUTING.md](./CONTRIBUTING.md) lists every gate CI
runs.

## Contributing and security

[CONTRIBUTING.md](./CONTRIBUTING.md) is the short path from a fresh clone to
a green pull request; CI runs the same gates. Report vulnerabilities privately
through [SECURITY.md](./SECURITY.md). Package release notes
live in [CHANGELOG.md](./CHANGELOG.md), and the release procedure in
[CONTRIBUTING.md](./CONTRIBUTING.md#releasing).

## License

MIT. See [LICENSE](./LICENSE).
