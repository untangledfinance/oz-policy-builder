# Prime on EVM: the leverage-yield execution adapter

**Date:** 28 October 2026.
**Status:** verified on a fork of Base Sepolia against the live Safe, Zodiac
Roles v2.1.1 and Aave v3 contracts. The live on-chain run is pending a funded
key (see [The on-chain run](#the-on-chain-run)).
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

The live run on Base Sepolia is pending a funded key. The throwaway deployer the
reference line used (`0x00ccd1A17fD215d8104e712a220AbA6aA6D5F901`) still holds
about 0.0144 test ETH on Base Sepolia, enough for the run, but its key file was
removed in a disk cleanup and cannot be recovered. A Base Sepolia faucet needs a
login or a CAPTCHA, so the run cannot fund a fresh key on its own. A fresh
throwaway deployer is ready at `0x41524EF4C574377c4e780f409337Bf03C52Faa11`; once
it holds test ETH, or the original key is restored, the live run follows the
same shape as the fork test: write the template, mint the test assets through
the Aave faucet (`0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc`,
`mint(token, to, amount)`), run a real open and a real close, send a batch of
refusals, and read every transaction back on a second RPC, the way the reference
line did.

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
