# Prime on EVM: the leverage-yield execution adapter

**Date:** 28 October 2026.
**Status:** verified on a fork of Base Sepolia against the live Safe, Zodiac
Roles v2.1.1 and Aave v3 contracts, and run live on Base Sepolia on 28 October
2026 (see [The on-chain run](#the-on-chain-run)).
**Scope:** the config-only execution adapter for Mr. Quan's tokenised-gold
leveraged-yield flow. It adds no contract of Prime's. The adapter is a Zodiac
Roles policy template on the same custody gate the custody-yield reference line
uses ([docs/evm.md](../docs/evm.md)), plus the batch an actor signs. The source
of the use case is the Gemini note of 28 October 2026 and the local analysis
`my-wiki/plans/prime-evm-execution-adapter-analysis-2026-10-28.md`.

## The flow

A user holds tokenised gold in the custody Safe, borrows a stablecoin on Aave
against it, and deploys the borrowed stablecoin into a yield source that pays
more than the borrow cost. The spread is the carry. The user sets the leverage
when they sign, through the borrow amount they sign, the way Untangled Loop sets
leverage. OctoPos and an agent watch the position and close it when the spread
turns.

Every amount in the flow is fixed when the user signs or is a max sentinel, so
the batch needs no runtime output chaining and no flash loan. The analysis
proved this leg by leg: the gold supplied, the stablecoin borrowed and the
stablecoin deposited are all the fixed numbers the user signs; the close redeems
the shares read at signing, repays with `type(uint256).max` (Aave repays the
whole debt and accrued interest), and withdraws the gold with
`type(uint256).max`. One Safe MultiSend batch, with each inner call checked by
Roles, carries the whole open and the whole close.

**Open (one batch):**

1. `approve(gold, aavePool, g)`
2. `supply(gold, g, onBehalfOf = Safe, 0)`
3. `borrow(stable, b, 2, 0, onBehalfOf = Safe)`
4. `approve(stable, yieldVault, b)`
5. `deposit(stable, b, receiver = Safe)`

**Close (one batch):**

1. `redeem(shares, receiver = Safe, owner = Safe)`
2. `approve(stable, aavePool, max)`
3. `repay(stable, max, 2, onBehalfOf = Safe)`
4. `withdraw(gold, max, to = Safe)`

## The execution adapter on EVM

On Stellar and Solana the execution adapter is a contract of Prime's. On EVM
the same role is filled by configuration on canonical contracts:

1. a **policy template**, a set of Zodiac Roles scopes on the custody gate that
   allow exactly the open and the close calls and refuse everything else; and
2. an **app-side batch builder** that assembles the MultiSend the actor signs.

Both ride on the Safe, Zodiac Roles v2.1.1 and Safe MultiSend contracts the
reference line already uses. Nothing new is deployed.

## The actor model

The custody gate carries a role, `leverage-yield`. Its members are the two
initiators of Mr. Quan's flow:

- the **Prime account**, a Safe whose owners approve at their threshold (2 of
  3): the user's one-click open and close, co-signed; and
- a **scoped agent key**: the OctoPos monitoring agent, so it can close the
  position when the spread turns.

Either member sends one transaction to the gate:

```
execTransactionWithRole(
    MultiSendCallOnly, 0, multiSend(open or close legs),
    operation = delegatecall, roleKey = "leverage-yield", shouldRevert = true
)
```

Custody registers the Roles MultiSend unwrapper for the MultiSend selector on
the gate, so the gate splits the batch and checks each inner call against the
`leverage-yield` scopes. After every leg passes, the custody Safe runs the batch
through `MultiSendCallOnly`, so the five open legs or the four close legs
execute as one atomic transaction: any refusal reverts the whole batch and
nothing moves. The scopes are the same whoever calls, so the borrow cap, the
pinned recipients and the target allow-list bound the agent and the Prime owners
alike. The agent holds no extra reach; custody's scopes are the whole fence.

Custody can wrap either member further without touching the leverage scopes: it
can make the member a move timelock, so every batch waits a delay (the shape the
custody-yield reference line uses), or hold the agent inside a Prime-account
band. The leverage-yield template is independent of that choice. The fork test
exercises the no-delay path, the one Mr. Quan's one-click flow needs.

## The policy template

Custody writes the template to the gate in one transaction signed by its three
signers. The `leverage-yield` role allows these calls and no others. Every
recipient of funds or of a position is pinned to the custody Safe with
`EqualToAvatar`, which the gate resolves to its own avatar.

| Call | Target | Conditions |
|---|---|---|
| `approve(spender, amount)` | gold (cbETH) | spender equal to the Aave pool; amount open |
| `approve(spender, amount)` | stable (USDC) | spender equal to the Aave pool or the yield vault; amount open |
| `supply(asset, amount, onBehalfOf, referral)` | Aave pool | asset equal to the gold; `onBehalfOf` the custody Safe |
| `borrow(asset, amount, rateMode, referral, onBehalfOf)` | Aave pool | asset equal to the stable; amount within the `leverage-borrow` allowance; rateMode variable (2); `onBehalfOf` the custody Safe |
| `repay(asset, amount, rateMode, onBehalfOf)` | Aave pool | asset equal to the stable; amount open, so `type(uint256).max` repays the debt; rateMode variable; `onBehalfOf` the custody Safe |
| `withdraw(asset, amount, to)` | Aave pool | asset equal to the gold; amount open, so `type(uint256).max` withdraws the gold; `to` the custody Safe |
| `deposit(assets, receiver)` | yield vault | receiver the custody Safe |
| `redeem(shares, receiver, owner)` | yield vault | receiver and owner the custody Safe |

Properties of the template:

- **The borrow cap is the leverage control:** the borrow amount is bound by the
  `leverage-borrow` Roles allowance, a budget custody sets to the ceiling the
  user signs. This is option A of the analysis (G1): the ratio is set at
  signing, shown on the review card, and bound on chain by the cap. A Roles
  condition reads no price, so it cannot read the gold oracle to hold a ratio;
  Aave's own collateral factor and health factor still apply at execution, below
  the cap. An on-chain ratio check would need a `Custom` condition contract,
  which is out of scope here.
- **The approval amount is open, the spender is pinned:** a repay or a deposit
  can use an infinite approve, and the spender can only be the Aave pool or the
  yield vault, so an approval can never reach a stranger. The funds themselves
  are bound by the supply, borrow and deposit scopes.
- **Delegatecall is off:** the role turns on no delegatecall for any venue. The
  one delegatecall in the flow is to `MultiSendCallOnly` through the registered
  unwrapper, the batch mechanism. A direct delegatecall to a venue is refused
  with the Roles delegatecall status.
- **Everything else is refused**: a plain transfer of the gold, an approval to a
  stranger, a supply or a borrow for a stranger, a deposit or a redeem to a
  stranger, a withdraw to a stranger, a borrow of an asset the template does not
  list, a call to an unscoped target, a call to the custody Safe or to the gate
  itself, and a non-member.

## The testnet assets

Aave v4 has no public testnet, so the adapter is prototyped on the Aave v3 test
market on Base Sepolia, as the reference line was.

| Role | Asset | Address | Why |
|---|---|---|---|
| Gold stand-in (collateral) | cbETH (18 decimals) | `0xD171b9694f7A2597Ed006D41f7509aaD4B485c4B` | an Aave v3 collateral reserve (LTV 82.5%); supplied and withdrawn only, the role gold plays |
| Borrow stablecoin | USDC (6 decimals) | `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f` | the market's test stablecoin, borrowing enabled, deep test liquidity |
| Yield source | MockVault | a test fixture | no liquid ERC-4626 vault on Base Sepolia lists the borrow stablecoin |

The first choice for the gold stand-in was WBTC, the most gold-like store of
value and a reserve with borrowing disabled. The test market's WBTC supply cap
is full (175 of 175), so a supply reverts. cbETH is the practical stand-in: an
Aave v3 collateral with no supply cap, faucet-mintable. The template never
scopes a borrow of the collateral, so cbETH stands only as collateral, as gold
would.

`MockVault` is a minimal ERC-4626-shaped yield source, a test fixture only, the
way the reference line's mock router is a fixture. Shares are 1 to 1 with the
asset, and a one-off top-up lets the close return more than the deposit, so the
carry nets a spread. It is never deployed on a network and is not a Prime
production contract. A production deployment points the template's `deposit` and
`redeem` scopes at a real liquid ERC-4626 vault that lists the borrow
stablecoin.

## The fork test

[`scripts/evm-config-check/test/LeverageYield.t.sol`](../scripts/evm-config-check/test/LeverageYield.t.sol)
builds the custody Safe, the gate and the leverage-yield template on a fork of
Base Sepolia and runs the flow against the live contracts. It runs once per Safe
version, 31 checks each, in
[run-leverage-2026-10-28.txt](../scripts/evm-config-check/run-leverage-2026-10-28.txt).

What it proves, each check with the status it must carry:

- **The open runs atomically** through the Roles MultiSend path: supply the
  gold, borrow the stablecoin and deposit it into the yield source in one
  transaction. Custody holds the gold position, carries the Aave debt and holds
  the yield shares; the Prime account holds nothing; the position is healthy.
- **The borrow cap bounds the leverage:** a borrow over the signed cap is
  refused with the Roles allowance status.
- **Aave's own health factor still applies:** a borrow within the cap that the
  collateral cannot support reverts at Aave.
- **The close runs atomically:** redeem the shares, repay the debt with the max
  sentinel and withdraw the gold with the max sentinel, in one transaction. The
  debt clears, the gold returns to custody, no shares remain, and custody keeps
  the carry spread.
- **Every out-of-scope call is refused** with its Roles status: a call to an
  unscoped target, a plain transfer of the gold, an approval to a stranger, a
  supply or a borrow for a stranger, a borrow of an unlisted asset, a deposit or
  a redeem to a stranger, a withdraw to a stranger, a delegatecall to the pool,
  a call to the custody Safe or the gate itself, and a non-member.

The run uses Safe 1.4.1 and Safe 1.5.0, the way the reference line and the base
checks do. It does not change `test/ConfigOnly.t.sol` or any other existing
test; it adds one file.

```sh
cd scripts/evm-config-check
npm pack @openzeppelin/contracts@5.6.0 && tar xzf openzeppelin-contracts-5.6.0.tgz
mkdir -p lib/oz && cp -r package/* lib/oz/ && rm -r package openzeppelin-contracts-5.6.0.tgz
FORK_URL=https://sepolia.base.org forge test --match-contract LeverageYieldTest -vv
```

## The on-chain run

The line ran on Base Sepolia (chain 84532) on 28 October 2026. The deployer is a
throwaway key funded for the run, 0.05 Ethereum Sepolia ETH from the Google
Cloud faucet, bridged to Base Sepolia through the Base L1 standard bridge
(`bridgeETHTo`, 0.03 ETH, tx
`0x9a27bb18707a776fca4c86a97ac4548f5ba3e45171d5d329af3a22a54f6686cb` on
Ethereum Sepolia). The deployer is the gate's `leverage-yield` member, the
scoped-agent path; the Prime-account member path is proven on the fork. The
whole run cost about 0.001 test ETH. Every transaction below was read back on a
second RPC (`https://base-sepolia-rpc.publicnode.com`), status and block
included.
[`script/LeverageYieldLive.s.sol`](../scripts/evm-config-check/script/LeverageYieldLive.s.sol)
builds the run; its encoders are copied from the fork test.

**Addresses:**

| Role | Address |
|---|---|
| Deployer / scoped-agent member | `0x41524EF4C574377c4e780f409337Bf03C52Faa11` |
| Custody Safe (3 of 3) | `0x77286247F668c1a7f57100649fCebf130cDCA127` |
| Custody gate (Roles v2.1.1 proxy) | `0x0a66a3c6B539474526A279B82A6F90717089a718` |
| MockVault (yield fixture) | `0x6Bf85659745daFE2fd8622c1e49d346d0f62D460` |
| Non-member (refusal) | `0x7199e355F9A23368D8d6a71AC60303D4E11de4BD` |

**Setup, open and close, each succeeded (status 1):**

| Step | Transaction |
|---|---|
| Create the custody Safe | `0xd929b8131f84380afb8221af1d3d414657e18d4a4f92c13656aa7ab585e08652` |
| Deploy the MockVault fixture | `0x80f1f750687c365fa90726e0f090ce4cf08cb27b56de369d9a7a3f8738ca9f40` |
| Write the leverage-yield template | `0x577e92b27783cf183d257bad8cb8f7767a8c475696d6e17efec50dce0622a1f1` |
| Mint the gold stand-in to custody | `0x3e86fa2ef0482a064d05c1fcb1c9dfcf0246b6196eb5ed41269cd74cc98000e4` |
| Mint the vault's standing yield | `0xfa30e605695d841639833700b69416f73c504cf1b5f6304d4f6c85a1dc67ba3c` |
| **OPEN** (supply gold + borrow USDC + deposit yield, one MultiSend) | `0x26ebb00d2a1d9a7c3c8fc2a9de5e8845a656d36d70bdc9f4b47d70c1f83635c4` (block 51454790) |
| **CLOSE** (redeem + repay-max + withdraw-max, one MultiSend) | `0xce463825420814defdb8281fb51465e93983a4486e4bc116ae51e174a8734a8e` (block 51454800) |

The open supplied 0.5 cbETH, borrowed 500 USDC and deposited the 500 USDC into
the vault, in one atomic transaction. After the close the position reads: Aave
debt 0, custody cbETH 1.000000000042348464 (all the gold back, plus supply
dust), custody USDC 99.999998 (the carry the vault paid). The debt is cleared,
the collateral is back and the carry is kept.

**Refusals, each reverted on chain (status 0) with its Roles status:**

| Refusal | Roles status | Transaction |
|---|---|---|
| A call to an unscoped target | `ConditionViolation` 2 (target) | `0x27f828d379b9b215144db1085267ae66e49ac4f006df0a802a708b1791c10353` |
| A borrow over the signed cap | `ConditionViolation` 17 (allowance, `leverage-borrow`) | `0xc62211cb5cc5da54cdcbfa7e6098f80be465b9b3bee1324e69de8227e7ffa8fc` |
| A supply for a stranger | `ConditionViolation` 7 (parameter) | `0xa3e84243547f96223802fe02f977929211e1255814a6af387754c96b5327bfaf` |
| A plain transfer of the gold | `ConditionViolation` 3 (function) | `0x0bcfe4dbda2c033b29ee5750dcfa41d2de3063e36e83e211424e893def0fce89` |
| A delegatecall to the pool | `ConditionViolation` 1 (delegatecall) | `0x65c50e785620e67f73d57f9d2f569a3dadefbf0a50d44399ea9b790bd3222913` |
| A borrow of an unlisted asset | `ConditionViolation` 7 (parameter) | `0xc080bf939973ba5913b1a26faf0fe2941a66b4b85456d99c94db34f7d46b0bec` |
| A non-member | `NotAuthorized` | `0xbd2bb6c10d247200dc24739a5d20daf338a0fcde9cb0b37b023a02d22e3fe640` |

Each refusal's revert data, read by `eth_call`, carried the same Roles status
the fork test asserts for the same call. Every transaction above, the successes
and the refusals, was confirmed on both `https://sepolia.base.org` and
`https://base-sepolia-rpc.publicnode.com`.

## Config-only confirmation

- No contract of Prime's is added on EVM. The adapter is Roles configuration on
  the canonical Safe, Zodiac Roles v2.1.1 and Safe MultiSend contracts.
- No existing `contracts/` source, no wasm and no `build-hashes.json` entry
  changes. The only `.sol` added is a test: the fork test and its `MockVault`
  fixture under the Foundry test directory.
- The canonical contracts the adapter configures are in
  [deployments/evm-testnet.json](../deployments/evm-testnet.json): Safe 1.4.1 and
  1.5.0, the Zodiac Roles v2.1.1 mastercopy
  (`0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5`), the Roles MultiSend unwrapper
  (`0x93B7fCbc63ED8a3a24B59e1C3e6649D50B7427c0`), Safe `MultiSendCallOnly`
  (`0x9641d764fc13c8B624c04430C7356C1C7C8102e2`) and the Aave v3 test market
  (`0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27`).
