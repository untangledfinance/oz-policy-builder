# EVM configuration check

A Foundry test that builds Prime on EVM, as [docs/evm.md](../../docs/evm.md)
describes it, on a fork of Base Sepolia and checks it against the live
contracts. It deploys only existing code: Safe proxies of the canonical Safe
1.4.1 and 1.5.0 singletons, ERC-1167 proxies of the Zodiac Roles v2.1.1
mastercopy, and OpenZeppelin's TimelockController 5.6.0 compiled from the npm
package. Prime has no contract of its own on EVM, and this folder adds none:
the `.sol` file is the test.

The test runs once per Safe version and makes 55 checks each time:

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

Foundry 1.8.4, solc 0.8.28 with `via_ir`. Without `FORK_URL` all four tests skip,
and `assert-tests.sh` then fails. CI runs the same command (job
`evm-config-check`). [run-2026-10-27.txt](run-2026-10-27.txt) is the run
of 27 October 2026, with six altered configurations that each make the test
fail.
