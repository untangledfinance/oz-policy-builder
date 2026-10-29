# Prime on EVM: the leverage-yield policy template

**Date:** 29 October 2026.
**Status:** verified on a fork of Base Sepolia against the live Safe, Zodiac
Roles v2.1.1 and Aave v3 contracts, for two market configurations, each under
Safe 1.4.1 and Safe 1.5.0 (see [Verification](#verification)).
**Source of truth:**
[`scripts/evm-config-check/test/LeverageYieldTemplate.sol`](../scripts/evm-config-check/test/LeverageYieldTemplate.sol).

This is the reusable form of the leverage-yield execution adapter proven in
[evidence/evm-leverage-yield.md](../evidence/evm-leverage-yield.md). The proof
wrote its Roles scopes by hand for one market. The template builds them from a
few parameters, so the Prime EVM app can install the same policy for any
custody Safe, configuration only.

## What it is

A user holds tokenised gold in a Prime custody Safe, borrows a stablecoin on
Aave against it, and deposits the stablecoin into a yield source that pays
more than the borrow cost. The open is one atomic MultiSend batch; so is the
close. Zodiac Roles on the custody gate checks every leg.

The template is a Solidity library of internal pure functions that return
calldata. Nothing in it is deployed. Its output is a list of Safe MultiSend
entries that custody signs once, writing scopes onto the custody gate it
already has (a Roles v2.1.1 modifier whose avatar, target and owner are the
custody Safe, as in [docs/evm.md](evm.md)). Three things read it:

- the fork test, `test/LeverageYield.t.sol`, which builds its scopes and
  batches from it and holds no copy of its own;
- the live script, `script/LeverageYieldLive.s.sol`;
- the install script, `script/LeverageYieldTemplate.s.sol`, which takes the
  parameters from the environment and prints the custody transaction to sign.

## Parameters

| Parameter | Meaning |
|---|---|
| `avatar` | the custody Safe: it holds the collateral, carries the debt and holds the yield shares |
| `gate` | the custody gate, a Roles v2.1.1 modifier wired to and owned by `avatar` |
| `collateral` | the tokenised gold, an Aave reserve listed as collateral |
| `pool` | the Aave v3 Pool |
| `borrowAsset` | the stablecoin borrowed, an Aave reserve with borrowing on |
| `yieldVault` | an ERC-4626 vault whose `asset()` is `borrowAsset` |
| `borrowCap` | the borrow budget in `borrowAsset` units: the leverage signed at setup |
| `users` | members of the open role: the Prime account |
| `agents` | members of the close role: the OctoPos agent; may be empty |
| `agentWithdraw` | whether an agent may also withdraw the collateral to custody (default off) |

`validate` refuses, before anything is signed: a zero address; the collateral
equal to the borrow asset; two of avatar, gate, collateral, pool, borrow asset
and vault sharing an address; a zero cap; no user member; a member that is the
custody Safe, the gate, a venue or a token; a duplicate member; an address
that is both a user and an agent; `agentWithdraw` with no agent. `verify` adds
the chain reads: the gate's avatar, target and owner are the custody Safe, and
the vault's `asset()` is the borrow asset.

## The actor model

The template writes two roles on the gate.

- **`leverage-yield`, the open role:** its members are the `users`: the Prime
  account, a Safe whose owners approve at its threshold (2 of 3). This is the
  user's one-click path: the app builds the batch, the Prime owners co-sign,
  and the Prime account sends it to the gate. The role carries every open leg
  and every close leg.
- **`leverage-close`, the close role:** its members are the `agents`: the
  OctoPos agent that watches the spread. The role carries only the close legs:
  redeem the yield to custody, approve the stablecoin to the pool, repay for
  custody, and, when `agentWithdraw` is set, withdraw the collateral to
  custody. An agent can lower the debt or end the position. It cannot borrow,
  supply, deposit, approve the vault or send anything to any address but
  custody.

Either member sends one transaction to the gate:

```
execTransactionWithRole(
    MultiSendCallOnly, 0, multiSend(legs),
    operation = delegatecall, roleKey, shouldRevert = true
)
```

The template registers the Roles MultiSend unwrapper for `MultiSendCallOnly`,
so the gate splits the batch and checks each leg against the caller's role.
When every leg passes, the custody Safe runs the batch; if any leg is refused,
the whole transaction reverts and nothing moves.

The two roles are a choice this template makes over the proof, where both
members shared one role. With one role, a leaked agent key could open new
leverage up to the cap. With two, the agent's worst case is an early close.

## The scopes

Every recipient and every `onBehalfOf` is pinned to the custody Safe with
`EqualToAvatar`. No scope allows value or delegatecall. A target or function
the template does not list is refused by Roles.

**`leverage-yield` (users):**

| Call | Target | Allows | Refuses |
|---|---|---|---|
| `approve(spender, amount)` | collateral | spender is the pool; any amount | any other spender |
| `approve(spender, amount)` | borrow asset | spender is the pool or the vault; any amount | any other spender |
| `supply(asset, amount, onBehalfOf, referral)` | pool | asset is the collateral; `onBehalfOf` is custody | another asset; another beneficiary |
| `borrow(asset, amount, rateMode, referral, onBehalfOf)` | pool | asset is the borrow asset; amount within the `leverage-borrow` allowance; variable rate (2); `onBehalfOf` is custody | another asset; over the cap; stable rate; another debtor |
| `repay(asset, amount, rateMode, onBehalfOf)` | pool | asset is the borrow asset; any amount (`max` repays all); variable rate; `onBehalfOf` is custody | another asset; another debtor |
| `withdraw(asset, amount, to)` | pool | asset is the collateral; any amount (`max` withdraws all); `to` is custody | another asset; another recipient |
| `deposit(assets, receiver)` | vault | receiver is custody | another receiver |
| `redeem(shares, receiver, owner)` | vault | receiver and owner are custody | another receiver or owner |

**`leverage-close` (agents):**

| Call | Target | Allows |
|---|---|---|
| `approve(spender, amount)` | borrow asset | spender is the pool |
| `repay(asset, amount, rateMode, onBehalfOf)` | pool | as above |
| `withdraw(asset, amount, to)` | pool | as above, only when `agentWithdraw` is set |
| `redeem(shares, receiver, owner)` | vault | as above |

The close role does not scope the collateral token at all, and on the pool and
the vault it scopes no function but these.

Refused for every member: a plain `transfer` or `transferFrom` of either token,
any other Aave function (`setUserUseReserveAsCollateral`, `supplyWithPermit`,
`repayWithATokens`, flash loans), any other vault function, a call to the
custody Safe, a call to the gate, and any address that is not a member.

## The batches

The library also builds the batches a member signs, so the app and the tests
send the same bytes.

- `openBatch(p, collateralAmount, borrowAmount)`: approve the collateral to
  the pool, supply it for custody, borrow `borrowAmount` for custody, approve
  it to the vault, deposit it for custody. Users only.
- `deleverageBatch(p, shares, repayAmount)`: redeem `shares` to custody,
  approve the pool, repay `repayAmount`. Either role. This is the agent's
  rebalance when the spread narrows or the LTV drifts up.
- `closeBatch(p, shares, withdrawCollateral)`: redeem, approve the pool for
  `max`, repay `max`, and optionally withdraw the collateral with `max`. A user
  may always include the withdraw; an agent only when `agentWithdraw` is set.
- `execCall(role, batch)`: the calldata for the gate.
- `rearmCall(cap)`: the calldata custody sends the gate to reset the borrow
  budget.

## Leverage and the borrow cap (option A)

The user sets the leverage when they sign, the way Untangled Loop does. On
chain the bound is the `leverage-borrow` Roles allowance:

- **The cap is the LTV at setup:** custody sizes `borrowCap` per account when
  it installs the template: the LTV the user chose, times the collateral value
  at that time, in stablecoin units.
- **The review card shows the implied LTV** of each open: the borrow amount
  over the collateral value at the oracle price at signing. The user owns the
  number they sign.
- **Aave's own maximum LTV is the hard backstop:** a borrow within the cap that
  the collateral cannot carry still reverts at Aave.
- **The cap is absolute:** the template sets the allowance with no refill.
  It is a budget for borrowing: each borrow spends from it, and time and
  repayments leave it as it is. A re-open after a close needs custody to re-arm
  it with `rearmCall`. Only custody, the gate's owner, can write it;
  a member can neither raise it through the gate nor call the gate directly.

This is option A of the design analysis: configuration only, no new contract.
Option B, a `Custom` Roles condition that reads the gold oracle and holds the
ratio on chain, would be a new contract and is not part of this template.

### What option A leaves open

- **No ratio on chain:** Roles compares calldata to constants. It cannot read
  a price, so it cannot hold `debt / collateral value` under a number. If gold
  falls, the LTV rises with no on-chain step. Monitoring and the agent's
  de-risk and close paths guard against this drift; Aave's liquidation
  threshold is the last line.
- **The cap is a fixed amount:** it is sized at setup for that account. It
  does not follow the collateral value, the amount supplied or the gold price.
  A user who supplies less collateral than planned can still borrow up to the
  cap, bounded only by Aave's maximum LTV.
- **Interest is outside the cap:** the cap bounds the principal borrowed;
  accrued interest grows the debt past it.
- **An agent with `agentWithdraw` can thin the collateral:** it can withdraw
  collateral to custody while debt remains, down to Aave's limit, which brings
  the position closer to liquidation. Nothing leaves custody, but the
  liquidation penalty is a real loss. This is why the default is off: an agent
  then clears the debt and the user withdraws.
- **An agent can redeem without repaying:** the stablecoin goes to custody
  and stops earning. Nothing leaves custody.
- **Approval amounts are open:** the spender is pinned to the pool or the vault,
  so a standing approval can only be spent by them, on calls that pay custody.
- **The close is atomic only if the vault redeems at once:** a vault with a
  queue or a lock-up makes the redeem leg revert, and so the whole close. The
  template suits liquid ERC-4626 vaults.
- **Trailing calldata passes:** Roles checks the arguments it scopes, and
  bytes after the last one still pass. This is the known gap recorded in
  [evidence/stride-evm.md](../evidence/stride-evm.md).

## Installing it

Custody signs one transaction with all its signers. For a new account, append
the template to the gate's own deployment entries (CreateCall, `setUp`,
`enableModule`), as the fork test does. For an existing gate:

```sh
cd scripts/evm-config-check
AVATAR=<custody Safe> GATE=<gate> COLLATERAL=<gold> POOL=<Aave v3 pool> \
BORROW_ASSET=<stablecoin> YIELD_VAULT=<ERC-4626> BORROW_CAP=<units> \
USERS=<Prime account> AGENTS=<agent> \
forge script script/LeverageYieldTemplate.s.sol --fork-url <rpc>
```

It prints `to` (Safe MultiSend 1.4.1), `operation` 1 and `data`, the Safe
transaction custody signs. When the gate is already on chain it runs `verify`
first and stops on a mismatch, such as a vault whose asset is not the borrow
asset.

Custody can remove a member with `assignRoles(member, [role], [false])`, or
stop the template by revoking the targets, both through the gate it owns.

## Verification

[`test/LeverageYield.t.sol`](../scripts/evm-config-check/test/LeverageYield.t.sol)
runs the template on a Base Sepolia fork for two configurations:

| Config | Collateral | Borrow | Open | Cap | Agent withdraw |
|---|---|---|---|---|---|
| A | cbETH (LTV 82.5%) | USDC | 0.5 cbETH, borrow 500 USDC | 600 USDC | off |
| B | WETH (LTV 83.5%) | USDT | 0.5 WETH, borrow 500 USDT | 700 USDT | on |

cbETH and WETH stand in for tokenised gold, which Base Sepolia does not list;
both are Aave v3 collateral, supplied and withdrawn only. LINK was the first
choice for config B, but the test market's LINK supply cap is all but full.
The yield vault is `MockVault`, a test fixture under the Foundry test
directory, since no liquid ERC-4626 vault on Base Sepolia lists the stablecoins.

Each configuration runs under Safe 1.4.1 and Safe 1.5.0: 62 checks per run for
A and 59 for B (B's agent closes in one batch, where A's close takes three
steps and four checks). An offline test adds 12 checks on the parameter validation. The run is
in
[run-leverage-template-2026-10-29.txt](../scripts/evm-config-check/run-leverage-template-2026-10-29.txt).

What the runs prove:

- custody installs the template and deploys the gate in one transaction, and
  `verify` passes;
- an open batch whose last leg pays a stranger is refused whole, and nothing
  moves;
- the open runs as one batch: collateral supplied, debt carried by custody,
  shares held by custody, no stablecoin left idle, the Prime account empty;
- the cap is exact: one unit over is refused, the remainder up to the cap
  runs, and once spent it is still refused 30 days later;
- the agent cannot use the open role, cannot run an open batch under its own
  role, cannot borrow, supply, deposit, approve the vault, transfer either
  token, redeem to itself, repay another account's debt or withdraw to itself;
- the agent de-risks in one batch: the debt falls and the health factor rises;
- the close runs as one batch: in A the agent's close with a withdraw is
  refused whole, the agent clears the debt and the user withdraws; in B the
  agent closes in full. The debt is zero, the collateral is back within dust,
  no shares remain and custody keeps the carry;
- a re-open on the spent cap is refused whole; the user cannot re-arm it
  through the gate or on the gate directly; custody re-arms it and the re-open
  runs;
- inside a re-armed cap, Aave refuses a borrow the collateral cannot carry;
- the user's refusals, each with its Roles status: an unscoped target, a
  transfer or `transferFrom` of the collateral, a transfer of the stablecoin,
  an approval to a stranger on either token, a supply, borrow, deposit, redeem
  or withdraw for a stranger, a stable-rate borrow, a borrow or supply of an
  unlisted asset, a borrow of the collateral, a delegatecall, a call with
  value, a call to the custody Safe or the gate, the user under the agent's
  role, and a stranger under either role.

Five mutations of the template were each caught by a failing check: a refilling
cap, an uncapped borrow, an agent allowed to approve the vault, an unpinned
deposit receiver, and a borrow in the agent's role.

`test/ConfigOnly.t.sol`, `test/RefLine.t.sol` and `test/StrideTimelock.t.sol`
are unchanged and pass.

```sh
cd scripts/evm-config-check
FORK_URL=https://sepolia.base.org forge test --match-contract LeverageYieldTest -vv
```

## Configuration only

- The template adds no contract to any chain. The library is never deployed;
  its functions return calldata.
- No `contracts/` source, no wasm and no `build-hashes.json` entry changes.
- Every contract the tests deploy is existing code (Safe proxies, Zodiac Roles
  v2.1.1 proxies), plus the `MockVault` test fixture.
- A production install points `collateral` at a real tokenised-gold reserve,
  `pool` at an Aave market that lists it, and `yieldVault` at a liquid ERC-4626
  vault for the borrow stablecoin.
