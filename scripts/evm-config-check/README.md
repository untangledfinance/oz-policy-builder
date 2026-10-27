# EVM configuration check

Foundry tests that build Prime on EVM, as [docs/evm.md](../../docs/evm.md)
describes it, on a fork of Base Sepolia and check it against the live
contracts, and a script that runs the same line on a chain. They deploy only
existing code: Safe proxies of the canonical Safe 1.4.1 and 1.5.0 singletons,
ERC-1167 proxies of the Zodiac Roles v2.1.1 mastercopy, and OpenZeppelin's
TimelockController 5.6.0 compiled from the npm package. Prime has no contract
of its own on EVM, and this folder adds none: the `.sol` files are tests and a
forge script.

Three tests, each run once per Safe version:

- `test/RefLine.t.sol` builds the design of docs/evm.md, where every move waits
  in a move timelock, and runs it phase by phase with the clock moved past each
  delay: 128 checks per Safe version. Its phases live in
  `script/RefLine.s.sol`, which also runs them on a chain (see
  [The reference line](#the-reference-line)).
- `test/ConfigOnly.t.sol` holds the base checks of the Safe and Roles parts,
  with the Prime account as the gate's trading member and no move delay, and
  the STRIDE attack cases.
- `test/StrideTimelock.t.sol` extends `RefLineBase` with the move-timelock
  STRIDE proof-of-concept cases for
  [evidence/stride-evm.md](../../evidence/stride-evm.md) section 11: the open
  executor and the missing run-window, the agent's cap spent at scheduling, a
  scheduled move that outlives its band, the proposer's reach into the
  timelock's own delay, and salt replay. 71 checks per Safe version, in
  [run-stride-timelock-2026-10-27.txt](run-stride-timelock-2026-10-27.txt).

`ConfigOnly.t.sol` makes 55 checks each time:

- **Setup:** the custody Safe (3 of 3), the Prime account (2 of 3), each
  Safe's Roles modifier deployed through `CreateCall` and enabled in one
  transaction of the Safe's own, the gate's trading and recovery roles, the
  Prime account's band for the agent, and the recovery timelock.
- **Moves:** the agent approves and supplies 10 USDC to the Aave pool in one
  batch, custody holds the position, and the Prime account and the agent
  hold nothing; the agent's band and daily cap, and custody's daily cap.
- **Refusals:** each with the Roles status it must fail with, for example a
  supply or withdrawal for a stranger, a plain transfer, an approval to a
  stranger, a borrow, a delegatecall, a call to the custody Safe or the gate
  itself, a non-member, the agent over its band or cap, and the Prime owners
  over custody's cap.
- **Recovery and stopping:** a recovery scheduled by the Prime owners,
  cancelled by custody, run by anyone after the delay, and refused for any
  address but the trustee; custody revoking the trading role and then turning
  the gate off; two of three custody signers and one Prime owner refused.

The same file adds the STRIDE attack cases (`test_stride_safe141`,
`test_stride_safe150`), 26 checks per Safe version, built for
[evidence/stride-evm.md](../../evidence/stride-evm.md). They either refuse an
attack with the exact Safe or Roles status (a stranger on the custody module
path `GS104`, a stranger adding an owner `GS031`, a stranger or the Prime
account writing a gate rule `OwnableUnauthorizedAccount`, a stranger cancelling
a recovery `AccessControlUnauthorizedAccount`, a supply once the budget is zero,
one agent signature against the 2-of-3) or show a documented gap (calldata
after the last pinned argument still passes; a function scope returns after
`revokeTarget` then `scopeTarget`). They also read back that custody renounced
the timelock admin role and that each module is a minimal proxy to the Roles
mastercopy. The run is in
[run-stride-2026-10-27.txt](run-stride-2026-10-27.txt).

```sh
cd scripts/evm-config-check
npm pack @openzeppelin/contracts@5.6.0 && tar xzf openzeppelin-contracts-5.6.0.tgz
mkdir -p lib/oz && cp -r package/* lib/oz/ && rm -r package openzeppelin-contracts-5.6.0.tgz
FORK_URL=https://sepolia.base.org ../../contracts/assert-tests.sh 4 forge test
```

Foundry 1.8.4, solc 0.8.28 with `via_ir`. Without `FORK_URL` all six tests skip,
and `assert-tests.sh` then fails. CI runs the same command (job
`evm-config-check`). [run-2026-10-27.txt](run-2026-10-27.txt) is the run
of 27 October 2026, with six altered configurations that each make the test
fail.

## The reference line

`script/RefLine.s.sol` and `refline.ts` run the same phases as
`test/RefLine.t.sol` on a chain, one transaction at a time: setup, schedule,
move and recover. Each phase runs first as a forge simulation that makes the
test's checks and writes the phase's transactions to a plan in `refline/`; the
driver sends them from throwaway keys, waits out each timelock delay, and
checks that every move succeeds and every refusal fails with the revert data
the simulation gave. It refuses any chain but Base Sepolia (84532).

```sh
anvil --fork-url https://sepolia.base.org --port 8547 --chain-id 84532   # for a fork run
KEYS=/path/to/keys.json bun refline.ts                                   # MODE=anvil
KEYS=/path/to/keys.json MODE=live RPC=https://sepolia.base.org bun refline.ts
```

`KEYS` names a JSON file, kept outside the repository, of
`{ address, privateKey }` for `deployer`, `custody1` to `custody3`, `prime1`
to `prime3`, `agent`, `trustee` and `stranger`; only the deployer needs test
ETH, and it sends the agent and the stranger theirs. `MOVE_DELAY` and `DELAY`
set the two timelock delays (120 and 300 seconds by default). The run's record
goes to `refline/<mode>-run.json`;
[`refline/anvil-run.json`](refline/anvil-run.json) is the run of 27 October
2026 on an anvil fork, described in
[evidence/evm-reference-line.md](../../evidence/evm-reference-line.md).
