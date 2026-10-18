# prime-seat

The seat of a NEAR-routed owner in a Squads Smart Account on Solana. A NEAR-routed owner is a person whose wallet lives on another chain (MetaMask or Freighter). Its owner key is an ed25519 key held by the NEAR MPC, so it never signs a Solana transaction. The owner signs one grant through NEAR and a session key then acts as the owner's seat for up to 7 days, with no further NEAR prompt.

A native owner (Phantom) needs no seat: its own key is a plain Squads signer. From 18 October 2026 sessions are seat-only, so a native owner has no session key.

## The seat

The seat is the PDA `["seat", owner, settings]` under this program, found with `find_program_address`, so only the canonical bump exists. The Smart Account lists it as a signer in its settings, and in any policy that lets it act alone. A seat holds no key. Only this program signs for it.

Give the seat `Vote` and `Execute` (mask 6) and leave out `Initiate`. Squads then refuses a seat's transaction creation by itself, and the program refuses it a second time. Activating a draft proposal needs `Initiate` in Squads, so a seat with mask 6 cannot activate one. A seat with mask 7 can, and the program still blocks transaction creation. Every Smart Account needs at least one signer with `Initiate`, and that signer is the native owner.

## What a session may do

A session key signs the Solana transaction. The program forwards exactly one Squads call as the seat.

| Squads call | Allowed |
|---|---|
| `createProposal`, `activateProposal`, `approveProposal`, `rejectProposal` | yes |
| `executeTransaction`, `executeSettingsTransaction` | yes |
| `executeTransactionSyncV2` with a policy payload of kind 0, 1 or 2 (`InternalFundTransfer`, `ProgramInteraction`, `SpendingLimit`) | yes |
| `executeTransactionSyncV2` with a vault transaction payload (the settings consensus) | no |
| `createTransaction`, `createSettingsTransaction`, `cancelProposal`, `useSpendingLimit`, every other call | no |

Only a native owner creates a transaction, so every change to the account carries a native owner's content. Sessions supply the other approvals, and they act alone only inside a policy that lists the seat. The payload tags in the call data pin the policy case: tag 1 (a policy payload) and a kind from 0 to 2. Kind 3 (`SettingsChange`) and any kind Squads adds later are refused, because this program is final and Squads can be upgraded. Squads checks that the payload kind matches the policy's own type, and a policy payload sent to the settings consensus fails in Squads.

## Instruction data

```
mode u8 | owner (32) | settings (32) | sig_ix u8 | [mode 0 only: start i64 BE | end i64 BE | Squads call data]
```

Accounts: `[0]` instructions sysvar, `[1]` session key (signs a mode 0 call), `[2]` marker, `[3..]` the Squads call's accounts. The Squads program must be among them (`activateProposal` does not list it, so add it). A seat appears unsigned in the transaction and the program signs it.

| Mode | Meaning |
|---|---|
| 0 | session action |
| 2 | end a session |
| any other | refused (`InvalidInstructionData`), mode 1 (the old wallet path) included |

## The grant

The owner signs this 32-byte hash, and the transaction carries it in an ed25519 instruction at index `sig_ix`:

```
sha256("prime-seat-grant" | cluster | settings | seat | session key | start (8 bytes BE) | end (8 bytes BE))
```

`cluster` is the text given as `PRIME_CLUSTER` at build time (`devnet` on beta). The program computes the hash from the call, so the grant is bound to one account, one seat, one program id (the seat derives from it), one cluster and one key. A mode 0 call needs `start <= now <= end` and `end - start <= 7 days`. The ed25519 instruction must have the standard layout of one signature with its fields inside the instruction itself (`Ed25519Program.createInstructionWithPublicKey` produces it), with the owner key and the 32-byte hash.

## Ending a session

An End is the grant hash with `start` and `end` at 0. The owner signs it through NEAR, or the session key signs the transaction itself. The transaction is, in order:

1. the ed25519 instruction (owner End only),
2. a System transfer of 890,880 lamports from the payer to the marker,
3. the mode 2 call.

The marker is the PDA `[owner, settings, key]` under this program. The program assigns it to itself, and a call must pass that address and is refused when the account is already ours. The program refuses an End when the marker holds no lamports. A marker that someone funded earlier does not block an End. The marker is never closed, so an ended key stays ended. A call that names the owner key as the session key is refused, which stops an owner from freezing its own seat.

## Refusals

| Error | Cause |
|---|---|
| `Custom(2)` | marker address not the derived one, or the key is already ended |
| `Custom(4)` | outside `start..end`, or longer than 7 days |
| `Custom(7)` | the ed25519 instruction is not the owner's signature over this grant |
| `Custom(8)` | a Squads call a session may not make |
| `Custom(9)` | the session key is the owner key |
| `InvalidInstructionData` | unknown mode or short data |
| `MissingRequiredSignature` | the session key did not sign a mode 0 call |
| `InsufficientFunds` | an End with an unfunded marker |

## Notes for integrators

- **Call depth:** `prime-seat` adds one call level above Squads. Devnet and mainnet run the 4-level limit today (SIMD-0268 is inactive there). A venue called through a policy move can then nest 3 calls below itself for a native signer and 2 for a seat session. Kamino and Orca calls fit. A venue that needs 3 nested calls goes through a native executor, and a depth probe on devnet should come before any deeper venue.
- **Creating a transaction is consent:** in a 2-of-3 account with one native owner and two seats, a native owner that creates a transaction and then rejects it cannot stop the two sessions from approving and executing it. Tell the native owner that creating a transaction is its signature on the decision.
- **A seat belongs to one account:** the grant binds the seat to its account by address, and the program forwards the call to any Squads account that lists the seat. Only the owners of that account can list it, so onboarding should check that a seat appears only in its own account and that account's policies.

## Build and test

```
PRIME_CLUSTER=devnet cargo test                       # 36 host tests with stubbed syscalls
PRIME_CLUSTER=devnet cargo mutants --in-place         # every viable mutant caught
PRIME_CLUSTER=devnet cargo-build-sbf -- --locked      # target/deploy/prime_seat.so
```

`cargo mutants` offers `Default::default()` for `ProgramResult` and never `Ok(())`, so it skips the three most important mutants. The agents' `manual-mutants.py` adds them with every literal the tool leaves alone.

`PRIME_CLUSTER` has no default, so a build without it fails. The host tests call `process` with the syscalls stubbed and record every inner call the program makes with the privileges the runtime would give it. A validator matrix against the real Squads program, a grant by real NEAR MPC and a venue-depth probe sit outside the repository (the agents' `near-int/solana` folder); their results are in the pull request.

| Build | sha256 | Bytes |
|---|---|---|
| `PRIME_CLUSTER=localnet` (CI) | `4428191fcb70aeb9230ff1706edaa0cdee853c75ee99aae0fa1c347d25177e3e` | 35,248 |
| `PRIME_CLUSTER=devnet` (beta) | `a389f4a1cbf67bee9be5170e2199e3fc4c02e596fe4fbab0406ecdeb8f5e9bb2` | 35,248 |

The source is 75 formatted lines (rustfmt defaults, non-blank non-comment). Deploy with `--final`, since the program holds no state and has nothing to upgrade. The devnet build is deployed final at `7ygNrKpK3GYoNLMCkAa4e3mznGPF2KVGbKZsJcq8wSCb` (upgrade authority none, deployed bytes equal the build). An earlier deployment, `5cMh4xVeYKX2BMdMKpbMbc4gXMaUUz6e96KtUmtsUiTs`, ran the deny-list build and is superseded.
