# Prime on Solana: technical detail

On Solana a Prime account is a Squads Smart Account. Two programs of ours sit
beside it: the custody gate, which owns custody's dedicated token account and
pays only where custody agreed, and `prime-seat`, which lets the session key of
an owner whose wallet lives on another chain act as that owner's seat. Both live
in `contracts/solana/` and run on Solana devnet only.
[architecture.md](architecture.md) shows how this fits with the other chains.

The design record with every run behind it is
[contracts/solana/README-architecture.md](../contracts/solana/README-architecture.md),
and the setup and recovery walkthrough is
[contracts/solana/SETUP-AND-RECOVERY.md](../contracts/solana/SETUP-AND-RECOVERY.md).
Both describe the Solana app as merged on 11 October 2026; this page states the
contracts as they are in this tree.

## Components

| Piece | Who wrote it | What it does |
|---|---|---|
| Squads Smart Account (`SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG`) | Squads, open source, upgradeable by its own multisig | The Prime account. Its settings signers vote M of N; its policies are the rules; its vaults sign for funds |
| Custody gate (`contracts/solana/custody-gate`) | us, 126 formatted sLOC | Owns custody's dedicated token account. Pays listed destinations within a cap for the agent lane, and the recovery address for the owners lane |
| `prime-seat` (`contracts/solana/prime-seat`) | us, 75 formatted sLOC | Checks a NEAR-routed owner's grant on every call by its session key, then signs one Squads call as the owner's seat |
| Seat PDA `["seat", owner, settings]` | derived, one per NEAR-routed owner per account | The owner's settings signer. Only `prime-seat` signs for it |
| ed25519 program | built into Solana | Verifies the owner's grant signature inside the session's transaction |
| `prime-near-signer-v2` | us, on NEAR | Gets the owner's grant signed by the NEAR MPC ([near.md](near.md)) |

## The account and its rules

A Squads Smart Account has N settings signers and a threshold M. Any M of them
can change anything: add or remove an owner, change the threshold, add or remove
a policy, approve a recovery. Policies are the rules: a policy lists its own
signers and limits what they may do alone. The kinds Prime uses are
`InternalFundTransfer`, `ProgramInteraction` (program, call data at fixed
offsets, accounts, account data, instruction count) and `SpendingLimit`. The
account has numbered vaults that sign for its funds.

The custody gate refuses a Smart Account that has a settings authority
(`custody-gate/src/lib.rs`, `create`), because that authority could add itself
as an owner. So every Prime account on Solana is autonomous: only its owners'
vote changes it.

## Owners and seats

| Owner's wallet | On the account | Signs |
|---|---|---|
| A Solana wallet (Phantom and other Wallet Standard wallets) | its own key, a settings signer with Initiate, Vote and Execute | every transaction itself, in its wallet |
| A wallet on another chain (MetaMask, Freighter) | a seat PDA, a settings signer with Vote and Execute (mask 6) | one grant through NEAR; the session key does the rest |

From 18 October 2026 a session key exists only for a seat. An owner whose wallet
is a Solana wallet has no session key and signs each action in its wallet.

**What a session may do:** `prime-seat` forwards exactly one Squads call as the
seat, chosen by its discriminator (`prime-seat/src/lib.rs`, `VOTE` and
`SYNC_V2`):

| Squads call | Allowed |
|---|---|
| `createProposal`, `activateProposal`, `approveProposal`, `rejectProposal` | yes |
| `executeTransaction`, `executeSettingsTransaction` | yes |
| `executeTransactionSyncV2` with a policy payload of kind 0, 1 or 2 (`InternalFundTransfer`, `ProgramInteraction`, `SpendingLimit`) | yes |
| `executeTransactionSyncV2` with any other payload, `createTransaction`, `createSettingsTransaction`, `cancelProposal`, `useSpendingLimit`, every other call | no (`Custom(8)`) |

A seat cannot create a transaction, and Squads also refuses a creation by a
signer without Initiate. So the content of every change comes from a native
owner, and the seats supply the other approvals. A session acts alone only
inside a policy that lists the seat. The program refuses kind 3
(`SettingsChange`) and any kind Squads adds later, because `prime-seat` is final
and Squads can be upgraded.

**The grant:** the owner key signs
`sha256("prime-seat-grant" ‖ cluster ‖ settings ‖ seat ‖ session key ‖ be64 start ‖ be64 end)`,
where `cluster` is the `PRIME_CLUSTER` string fixed at build time (`devnet` for
the deployed program). Nothing goes on chain at the grant. Every call by the
session key carries the grant signature in an ed25519 instruction of the same
transaction, and `prime-seat` checks:

1. the session key signed the transaction and is not the owner key
   (`Custom(9)`);
2. the ed25519 instruction at the given index verified the owner's signature
   over the grant hash the program computes from the call (`Custom(7)`);
3. `start <= now <= end` and `end - start <= 7 days` (`Custom(4)`);
4. the key has no End marker (`Custom(2)`);
5. the call is one a session may make (`Custom(8)`).

**Ending a session:** an End is the grant hash with start and end at 0, signed
by the owner through NEAR, or a transaction the session key signs itself. It
pays rent into the marker PDA `[owner, settings, key]`, and the program takes
that account over. Every later call by the key is refused, and the marker is
never closed, so the key stays ended. Removing the seat from the account's
settings and from every policy that lists it stops every session of that owner
at once.

**Removing a seat that a spending-limit policy lists:** rewriting a
`SpendingLimit` policy copies a stale usage, so the Prime app ends every such
policy that lists the seat and the owners create a new one if they want it.
`InternalFundTransfer` policies are rewritten without the seat. This is app
behaviour decided on 13 October 2026; the contracts do not enforce it.

## The custody gate

`contracts/solana/custody-gate/src/lib.rs`. Custody hands the owner and the close
authority of a dedicated token account to the gate PDA
`["gate", multisig, settings, seed]`. From then on only the gate signs for that
account, in four instructions:

| Instruction | Who | What |
|---|---|---|
| `create` (0) | any signer of custody's SPL Token multisig | Writes the gate once: the multisig, the Prime account's settings, the two lane vaults (numbers 1 or more, different from each other), the recovery address, the end time, the run window and the destination list. Nothing changes them later |
| `transfer` (1) | the agent lane vault | Pays a listed destination within the cap (the token program enforces the cap through the cap PDA `["cap", gate]` as delegate), until the end time, with a not-after inside the run window |
| `transfer` (1) | the owners lane vault | Pays the recovery address, with no cap, before or after the end time, with a not-after inside the run window |
| `allow` (2) | one multisig signer to lower or suspend the cap; the multisig's threshold to raise it | Sets the cap. Refuses a source whose close authority is set to anyone but the gate |
| `release` (3) | the multisig's threshold | Hands the account's close authority and owner back to a key the multisig chooses |

Errors: `Custom(1)` the caller is not a lane or the multisig signers fall short,
`Custom(2)` the destination is not allowed or the gate has ended, `Custom(4)` the
not-after is outside the run window, `Custom(5)` a wrong account. The gate
accepts only an account of exactly 355 bytes owned by a token program as
custody's multisig, and calls only the Token and Token-2022 programs.

The wait before a move lives in the Squads rule: a rule with a time lock stores
the whole batch (draw, venue call, proceeds back) and runs it as one
transaction. The gate has no queue.

## Build and test

The Solana CLI 4.3.0 (`cargo-build-sbf`, platform tools v1.57) builds both
programs. `PRIME_CLUSTER` goes into the seat's grant hash at compile time, so
each cluster gets its own `prime_seat.so`, and a build without it fails.

```sh
( cd contracts/solana/prime-seat &&
  PRIME_CLUSTER=devnet cargo test &&                       # 36 host tests, syscalls stubbed
  PRIME_CLUSTER=localnet cargo-build-sbf -- --locked )     # the build CI compares
( cd contracts/solana/custody-gate && cargo-build-sbf )
( cd contracts/solana/custody-gate/app-checks &&
  bun install --frozen-lockfile && bun run typecheck && bun test )   # 43 tests
```

| Build | sha256 | Bytes |
|---|---|---|
| `custody-gate` | `a5d19edb879e75d054f1025d710753ce5150726130c3dd74887236fbdbdc94e2` | 47,472 |
| `prime-seat`, `PRIME_CLUSTER=localnet` (CI) | `4428191fcb70aeb9230ff1706edaa0cdee853c75ee99aae0fa1c347d25177e3e` | 35,248 |
| `prime-seat`, `PRIME_CLUSTER=devnet` (deployed) | `a389f4a1cbf67bee9be5170e2199e3fc4c02e596fe4fbab0406ecdeb8f5e9bb2` | 35,248 |

The gate's validator harnesses (345 of 345 against a mock venue, 53 of 53 against
real Orca and Kamino state, 9 of 9 trustee checks) and its mutation pass are in
the spike bundle at tag `archive/spike-final`;
[contracts/README.md](../contracts/README.md#solana) links them.

## Deployed

Everything below is on Solana devnet. Each program was deployed with `--final`
and `--max-len` equal to its size, so it has no upgrade authority; that was read
again for the gate and the seat on 18 October 2026.

| Program | Devnet id | Build | State |
|---|---|---|---|
| `prime-seat` | `7ygNrKpK3GYoNLMCkAa4e3mznGPF2KVGbKZsJcq8wSCb` | `a389f4a1…` | current; the octopos Solana app pins it |
| custody gate | `6ieR7WUs2M2VxEFYosRLuMtCdrWs7sqUeM1P4d5jiUnz` | `a5d19edb…` | current; passed 84 of 84 gate-flow checks on devnet |
| `prime-seat`, deny-list build | `5cMh4xVeYKX2BMdMKpbMbc4gXMaUUz6e96KtUmtsUiTs` | earlier build | superseded: its payload check was a deny-list |
| custody gate, first build | `58L4q3DgvPdvRh7kX4v148EwEwd29WHh4RfaZJR69iYx` | `6d196cab…` | previous build |
| `prime-session` | `6JyReewxbo6D6UQNHEWWTXnC1CdBU8CqcQjoQbGNj9Ba` | `c8836361…` | removed from this repository on 18 October 2026; source at tag `archive/spike-final`. octopos main (`bb040c0a`) still starts move-only sessions of native owners on it |

None of these programs exists on Solana mainnet: a read of the seat and the gate
ids on mainnet-beta on 18 October 2026 returned no account.

## Limits

- **Creating a transaction is consent:** in a 2-of-3 account with one native
  owner and two seats, a native owner who creates a transaction and then rejects
  it cannot stop the two sessions from approving and executing it.
- **A seat belongs to one account by its address only:** the grant binds the
  seat to its account, and the program forwards a call to any Squads account
  that lists the seat. Only that account's owners can list it, so onboarding
  checks that a seat appears only in its own account and its policies.
- **Call depth:** `prime-seat` adds one call level above Squads. Devnet and
  mainnet run the 4-level limit (SIMD-0268 inactive), so a venue called through
  a policy can nest 3 calls below itself for a native signer and 2 for a seat
  session.
- **Squads and Token-2022 can be upgraded:** both programs have upgrade
  authorities on mainnet; the classic Token program is immutable. The gate and
  the seat are final, so a Squads upgrade can change what they rely on, and the
  gate harness has to run again after each one.
- **A freezable mint can be frozen by its issuer:** while USDC or USDT freezes a
  token account, recovery and release both fail until the issuer unfreezes it.
- **An owner majority reaches the recovery address and the cap:** M owners can
  pay the fixed recovery address at any time with no cap, and custody cannot
  stop a recovery once they sign. The Prime account's own time lock is the only
  wait in front of it.
- **Rent stays locked:** a gate-owned token account keeps its rent until a
  release hands it back, and every End marker keeps its rent for good.
