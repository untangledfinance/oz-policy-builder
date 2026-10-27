# Prime on EVM: the reference line

**Date:** 27 October 2026.
**Status:** on chain. The line ran on Base Sepolia (chain 84532) from 17:50:39 to
17:57:35 UTC by block time, blocks 51,007,854 to 51,009,931. Every transaction below links to
Basescan, and each was read back afterwards from a second RPC
(`base-sepolia-rpc.publicnode.com`), status and block included. A dry run of
the same line on an anvil fork had the same outcome for every transaction
([refline/anvil-run.json](../scripts/evm-config-check/refline/anvil-run.json)).
**Network:** Base Sepolia through `https://sepolia.base.org`, against the live
Safe 1.4.1, Zodiac Roles v2.1.1 and Aave test-market contracts. Every key is a
throwaway made for this run and kept outside the repository; nothing touches
mainnet.
**Design:** [docs/evm.md](../docs/evm.md): a custody Safe (3 of 3) with a
Roles gate, a Prime account (2 of 3) with the agent's band, a move timelock as
the gate's only trading member and a recovery timelock as its only recovery
member. The move delay is 120 seconds and the recovery delay 300 seconds, test
values; the fork test uses 1 hour and 2 days.
**Record:** [refline/live-run.json](../scripts/evm-config-check/refline/live-run.json)
holds every transaction with its hash, block, time, gas, fee and revert data,
and `referenceLine` in [deployments/evm-testnet.json](../deployments/evm-testnet.json)
the addresses.

## How it ran

```sh
cd scripts/evm-config-check
KEYS=/path/to/keys.json MODE=live RPC=https://sepolia.base.org bun refline.ts
```

The line runs in four phases of
[`script/RefLine.s.sol`](../scripts/evm-config-check/script/RefLine.s.sol):
setup, schedule, move and recover. Each phase first runs as a forge simulation
against the chain, makes the same checks as
[`test/RefLine.t.sol`](../scripts/evm-config-check/test/RefLine.t.sol) and
writes its transactions to a plan. [`refline.ts`](../scripts/evm-config-check/refline.ts)
then sends each one from the key the plan names and checks its receipt. A move
must succeed. A refusal must fail on chain, and its revert data must equal the
simulation's twice: by `eth_call` just before it is sent, and replayed against
the block before the one that holds it. Before the move phase the driver waits
for the move delay, and before the recover phase for the recovery delay, by the
chain's own block time. It refuses any chain but 84532.

The four simulations made 128 checks (setup 34, schedule 28, move 27, recover
39), the same 128 that `test/RefLine.t.sol` makes on each Safe version.

## The line

| Part | Address on Base Sepolia | Code |
|---|---|---|
| Custody Safe, 3 of 3 | [`0x56b90A323dFFf645DB579E0b0E11D4fEbe115550`](https://sepolia.basescan.org/address/0x56b90A323dFFf645DB579E0b0E11D4fEbe115550) | Safe proxy, 171 bytes; singleton SafeL2 1.4.1 `0x29fcB43b…C762` |
| Custody gate | [`0x24038e34749556773F201aAA5Dd043f5f00f35F6`](https://sepolia.basescan.org/address/0x24038e34749556773F201aAA5Dd043f5f00f35F6) | ERC-1167 proxy, 45 bytes, of the Roles v2.1.1 mastercopy `0xF2964CE6…83D5` |
| Prime account, 2 of 3 | [`0xaaC536a742f82c9db0c8CD758EDbeBD3E7369F56`](https://sepolia.basescan.org/address/0xaaC536a742f82c9db0c8CD758EDbeBD3E7369F56) | Safe proxy, 171 bytes; singleton SafeL2 1.4.1 |
| Band module | [`0xa61392F4E26505A3FdE1A2804E15f974Cf22110c`](https://sepolia.basescan.org/address/0xa61392F4E26505A3FdE1A2804E15f974Cf22110c) | ERC-1167 proxy, 45 bytes, of the same mastercopy |
| Move timelock | [`0x75Cb7Cb7281192b59e9aC550f0D91177F44b7100`](https://sepolia.basescan.org/address/0x75Cb7Cb7281192b59e9aC550f0D91177F44b7100) | TimelockController 5.6.0, runtime hash `0x56cf178a…507f` |
| Recovery timelock | [`0x17BEFE1Bb2a4Cae942Ef0746Dac1E86DC99FaF0f`](https://sepolia.basescan.org/address/0x17BEFE1Bb2a4Cae942Ef0746Dac1E86DC99FaF0f) | TimelockController 5.6.0, runtime hash `0x56cf178a…507f` |
| Agent | [`0xBA70a9A88205d23cBf83332a98134882E965C2E6`](https://sepolia.basescan.org/address/0xBA70a9A88205d23cBf83332a98134882E965C2E6) | a key |
| Trustee | [`0x0559025737F5AE1cd53084D28dfdA02033367558`](https://sepolia.basescan.org/address/0x0559025737F5AE1cd53084D28dfdA02033367558) | a key |
| Deployer | [`0x00ccd1A17fD215d8104e712a220AbA6aA6D5F901`](https://sepolia.basescan.org/address/0x00ccd1A17fD215d8104e712a220AbA6aA6D5F901) | a key; it paid for setup and relayed the Safe transactions |

No contract of ours is among them. The driver read each address's code after
the run: both Safes are proxies whose singleton is the canonical SafeL2 1.4.1,
the gate and the band module are 45-byte proxies of the Roles v2.1.1
mastercopy, and both timelocks' runtime hashes equal TimelockController as forge
1.8.4 builds it from `@openzeppelin/contracts` 5.6.0 (solc 0.8.28, `via_ir`, 200
runs). The timelock is the only code compiled for the line, and it is
OpenZeppelin's, unmodified. The two timelocks have the same addresses as in the
fork run because the deployer made them at the same nonces, 2 and 3.

## What the run shows

Each result below is the result `test/RefLine.t.sol` asserts, with the same
status.

- **The agent's move waits, then reaches custody:** the agent scheduled four
  supplies of 10 through its band (252,927 gas each) and nothing moved. After
  the delay it ran the first (302,201 gas): custody paid 10 USDC and holds the
  aUSDC, and the Prime account, the move timelock and the agent hold nothing.
- **The band refuses at scheduling, with the Roles status:** a supply of 100
  over the band (`9`, ParameterGreaterThanAllowed); a supply of 20 with 10 left
  of the agent's 50 a day (`17`, AllowanceExceeded); another asset, a USDC
  transfer, another target, the custody Safe as target, the recovery role and a
  delegatecall (`7`, ParameterNotAllowed); a withdrawal (`15`,
  BitmaskNotAllowed); `execute` through the band (`3`, FunctionNotAllowed).
  The agent on the timelock directly is refused by its role check, the agent on
  the gate and a stranger on the band by `NotAuthorized`, and a run before the
  delay by `TimelockUnexpectedOperationState`.
- **Custody cancels during the wait:** custody cancelled the agent's second
  move, and running it afterwards was refused.
- **The gate refuses when a move runs:** the Prime owners scheduled 16 moves in
  one Safe transaction. The approval, a supply of 140 and a withdrawal of 5 to
  custody ran. A supply of 51 with 50 left of custody's 200 a day was refused
  (`17`), and so were a supply or withdrawal for a stranger, an approval to a
  stranger (`7`), a USDC transfer and a borrow (`3`), an aUSDC transfer, a call
  to the custody Safe and a gate rule through the gate (`2`), a delegatecall
  (`1`), the recovery role (`NoMembership`) and a gate rule written by the
  timelock (`OwnableUnauthorizedAccount`). The gate's status comes back
  unchanged through the timelock's `execute`.
- **The kill switch stops moves already scheduled:** custody revoked the move
  timelock's trading role, and the agent's third move and an owners' withdrawal,
  both scheduled before, were refused (`NoMembership`).
- **Recovery works with trading off:** a stranger ran recovery r2 after its
  delay and custody paid the trustee 20 aUSDC. A cancelled recovery and one to a
  stranger (`7`) were refused, and after the full stop (`disableModule`) so was
  r4 (`GS104`).
- **Thresholds hold:** two of three custody signers (`GS020`) and one Prime
  owner (`GS020`) were refused.
- **The line comes back:** custody re-enabled the gate and the trading role in
  one transaction, and the agent's fourth move, scheduled before the kill
  switch, ran.

## Every transaction

| # | Phase | Transaction | Result | Gas | Transaction on Basescan |
|---|---|---|---|---|---|
| 1 | setup | T1a create the custody Safe (3 of 3) | succeeded | 283,428 | [`0x7be18b15…6983fe`](https://sepolia.basescan.org/tx/0x7be18b15bf12457699ae6c333fc2a652e5030f4d2d5a552b8f6f3fbbca6983fe) |
| 2 | setup | T1b create the Prime account (2 of 3) | succeeded | 283,428 | [`0x6d9ae53e…fe14bd`](https://sepolia.basescan.org/tx/0x6d9ae53ef2ecc75334ca058bfb986580b967108ea127997eda8a4b2664fe14bd) |
| 3 | setup | Move timelock (TimelockController 5.6.0) | succeeded | 1,400,895 | [`0x1e59711c…933a71`](https://sepolia.basescan.org/tx/0x1e59711c94e8cc566f71b6b695f10614ed5d8b1223b0c0bec5092d5586933a71) |
| 4 | setup | Recovery timelock (TimelockController 5.6.0) | succeeded | 1,400,907 | [`0x03ea8821…d31b58`](https://sepolia.basescan.org/tx/0x03ea882136a57269425437af24dbf95ca7a9e0ef9c08f4a691e4d90bedd31b58) |
| 5 | setup | T2 the Prime account sets up its Roles module and the agent band (2 of 3) | succeeded | 971,292 | [`0xbeb810e1…139db4`](https://sepolia.basescan.org/tx/0xbeb810e1896f7bb61284b0ef2a9556f88782b85e7e8cd9b46ea81f452d139db4) |
| 6 | setup | T3 custody sets up the gate, its trading and recovery roles and its cap (3 of 3) | succeeded | 1,365,333 | [`0x89eaeb4a…28c743`](https://sepolia.basescan.org/tx/0x89eaeb4a10c01be8aab7de5d696d574bb8d5a3a1eb818809affafe3db928c743) |
| 7 | setup | Aave faucet mints 1,000 test USDC to custody | succeeded | 87,902 | [`0xe3d78f1d…f105c3`](https://sepolia.basescan.org/tx/0xe3d78f1d6af9f96c1a6e886c1e85aad03f08c535e808fc1688e2f89fb6f105c3) |
| 8 | setup | Gas for the agent | succeeded | 21,000 | [`0x382215db…6b63b9`](https://sepolia.basescan.org/tx/0x382215db22f20c4a4e718d41374aeb16eb62ecbbd6405b052d9e843b0f6b63b9) |
| 9 | setup | Gas for the stranger | succeeded | 21,000 | [`0x24b92035…fee0b0`](https://sepolia.basescan.org/tx/0x24b92035631a384c780587df63bee2d342cdd7c66e3dcf55116a680340fee0b0) |
| 10 | schedule | Agent schedules move m1: supply 10 | succeeded | 252,927 | [`0xd56a3319…97c12e`](https://sepolia.basescan.org/tx/0xd56a3319b6905b6c9de7a0be576b09ce78ea8d8830338cfe822b8de47697c12e) |
| 11 | schedule | Agent schedules move m2: supply 10 (custody cancels it) | succeeded | 252,927 | [`0x4a8b9120…7e99e3`](https://sepolia.basescan.org/tx/0x4a8b91206376266f438dadc535ceb45171c8c93d7503d9e0f0af85d9c27e99e3) |
| 12 | schedule | Agent schedules move m3: supply 10 (runs after the kill switch) | succeeded | 252,927 | [`0xb2318d29…45b1fc`](https://sepolia.basescan.org/tx/0xb2318d2952b3aeec6bc2802af54f9946f5680dc7c25f18240a13b8d0dc45b1fc) |
| 13 | schedule | Agent schedules move m4: supply 10 (runs after the restore) | succeeded | 252,927 | [`0x08e1d1d1…d3cb49`](https://sepolia.basescan.org/tx/0x08e1d1d1acb65d839d94db3b864bad7c901f89a1374cccbb557fe649c7d3cb49) |
| 14 | schedule | Agent schedules a supply of 100, over its band | refused, `ConditionViolation(9 ParameterGreaterThanAllowed)` | 165,972 | [`0x1618cc4c…846822`](https://sepolia.basescan.org/tx/0x1618cc4cc71bec7d2b2a69678fbbb850b6bf3f9e22ca7975e7cf254c28846822) |
| 15 | schedule | Agent schedules a supply of 20 with 10 left of its daily 50 | refused, `ConditionViolation(17 AllowanceExceeded)` | 167,929 | [`0x2f5806f1…8da976`](https://sepolia.basescan.org/tx/0x2f5806f1fd498dfbf6b6ff66b020f94f6a116a9892f5dba5c15a75391e8da976) |
| 16 | schedule | Agent schedules a supply of another asset (aUSDC) | refused, `ConditionViolation(7 ParameterNotAllowed)` | 163,511 | [`0x6585eba2…f6d004`](https://sepolia.basescan.org/tx/0x6585eba225f2fcaac4760b14392d9f37ba0de2cbba939c08047f93718df6d004) |
| 17 | schedule | Agent schedules a withdraw, a call its band does not list | refused, `ConditionViolation(15 BitmaskNotAllowed)` | 172,115 | [`0x073d7faf…58d45e`](https://sepolia.basescan.org/tx/0x073d7faf651b14a6cf716da7708c0bbb8d9f849a91257f520dfe13ab5358d45e) |
| 18 | schedule | Agent schedules a USDC transfer, a call its band does not list | refused, `ConditionViolation(7 ParameterNotAllowed)` | 157,813 | [`0xa0cbb05e…98d8ea`](https://sepolia.basescan.org/tx/0xa0cbb05e37bd2794f133d52aa217c9f8f51f4f6df8268c495e3979af9398d8ea) |
| 19 | schedule | Agent schedules a supply at an off-list target | refused, `ConditionViolation(7 ParameterNotAllowed)` | 158,321 | [`0x2fa80a52…8497bb`](https://sepolia.basescan.org/tx/0x2fa80a52b009efd66e28155990fea1b6f5330efbc5e4aa834f149c6f848497bb) |
| 20 | schedule | Agent schedules a call to the custody Safe instead of the gate | refused, `ConditionViolation(7 ParameterNotAllowed)` | 153,136 | [`0xb404a61a…93767f`](https://sepolia.basescan.org/tx/0xb404a61a4972ee2d7d65900897418f9810663e0be148ea06ff6f03ab2e93767f) |
| 21 | schedule | Agent schedules a supply under the recovery role | refused, `ConditionViolation(7 ParameterNotAllowed)` | 175,173 | [`0x0dc558ee…0acf3c`](https://sepolia.basescan.org/tx/0x0dc558eeabbbcd3fa8c4fd44b3aa99f620a62efd33f6f55ef000b59c980acf3c) |
| 22 | schedule | Agent schedules a delegatecall from custody | refused, `ConditionViolation(7 ParameterNotAllowed)` | 173,657 | [`0x8b6f76aa…fa29fb`](https://sepolia.basescan.org/tx/0x8b6f76aae66adcc27a5e441464629e1a2db5182c078576cf1b67d2da58fa29fb) |
| 23 | schedule | Agent calls the move timelock's execute through its band | refused, `ConditionViolation(3 FunctionNotAllowed)` | 42,523 | [`0x887c27ae…051b29`](https://sepolia.basescan.org/tx/0x887c27ae54775ee334952f55f8ce282b4a22b9c6faf05409de242c38fb051b29) |
| 24 | schedule | Agent schedules on the move timelock directly | refused, `AccessControlUnauthorizedAccount(address,bytes32)` | 30,920 | [`0xb0494f34…c96348`](https://sepolia.basescan.org/tx/0xb0494f341dbbdfaa3cc2822c921b5d803b15d9aa03e264a7b7957c4b9dc96348) |
| 25 | schedule | Agent calls the gate directly | refused, `NotAuthorized(address)` | 33,120 | [`0xc7118922…efb573`](https://sepolia.basescan.org/tx/0xc7118922a845c775cadbdb399f74025882bcce93a3aaba2a1a6b99a883efb573) |
| 26 | schedule | A stranger uses the agent band | refused, `NotAuthorized(address)` | 36,045 | [`0x3f6bf649…be87e3`](https://sepolia.basescan.org/tx/0x3f6bf64917d5bbab41d86de4fd55399c45bd6775d5da7a0e616c373efbbe87e3) |
| 27 | schedule | Agent runs m1 before the delay | refused, `TimelockUnexpectedOperationState(bytes32,bytes32)` | 30,665 | [`0xde1c5ce0…2bb13a`](https://sepolia.basescan.org/tx/0xde1c5ce0e9890b5b59d92f8d4f6b10e8f25b4f8ddbffb1ae8f90e30bf52bb13a) |
| 28 | schedule | Prime owners schedule 16 moves in one transaction (2 of 3) | succeeded | 759,600 | [`0x2928ec05…8e8979`](https://sepolia.basescan.org/tx/0x2928ec05ca04f19a7c88f4890775de2d6352a4c258e2ba00aafe4d53a88e8979) |
| 29 | schedule | Custody cancels m2 during the wait (3 of 3) | succeeded | 80,725 | [`0xfffe969c…148435`](https://sepolia.basescan.org/tx/0xfffe969c0ca94f0c69c51ef4266ea02cef9ad82370527c58f4a74b8fc5148435) |
| 30 | schedule | A stranger schedules a recovery | refused, `AccessControlUnauthorizedAccount(address,bytes32)` | 29,590 | [`0x020d0329…6fff26`](https://sepolia.basescan.org/tx/0x020d0329cf3b9bf4277e479306e3a75b23c631ec44cee6deaaec82592b6fff26) |
| 31 | schedule | Prime owners schedule recoveries r1 to r4 in one transaction (2 of 3) | succeeded | 243,505 | [`0x238736fb…58f37a`](https://sepolia.basescan.org/tx/0x238736fbfc2333604f51772139d7ff4e4338412b3323a44c30d98e7c2358f37a) |
| 32 | schedule | A stranger runs recovery r2 before the delay | refused, `TimelockUnexpectedOperationState(bytes32,bytes32)` | 30,085 | [`0xc4579fb7…7af230`](https://sepolia.basescan.org/tx/0xc4579fb7278a61d2004a2fc3cd15bac2ae4d23b79eff853326ebbe2ab57af230) |
| 33 | schedule | Custody cancels recovery r1 (3 of 3) | succeeded | 80,749 | [`0x84db5d62…2d3e20`](https://sepolia.basescan.org/tx/0x84db5d62501c84c55078fbcd9c21731f148517e9112efb6b5a5a8f6fd02d3e20) |
| 34 | schedule | A stranger sets the move delay to 0 directly | refused, `TimelockUnauthorizedCaller(address)` | 21,632 | [`0x5950229b…85df3e`](https://sepolia.basescan.org/tx/0x5950229bf630379d3360239cdaa39db2b20d251a706d49759050b8b7c485df3e) |
| 35 | schedule | A stranger schedules a move delay of 0 | refused, `AccessControlUnauthorizedAccount(address,bytes32)` | 25,283 | [`0x9f929cfb…9fa67a`](https://sepolia.basescan.org/tx/0x9f929cfb36f0d2e5b4828ce71116163cc77a506f7af65397df141ab5539fa67a) |
| 36 | move | A keeper runs o-approve: custody approves the pool for 1,000 | succeeded | 124,879 | [`0x52df8c03…79f23e`](https://sepolia.basescan.org/tx/0x52df8c039908fecd7bf3dd2e834e63e88dff936791ac798881a29c164d79f23e) |
| 37 | move | Agent runs m1: custody supplies 10 to the pool | succeeded | 302,201 | [`0x31de6f09…fedd4b`](https://sepolia.basescan.org/tx/0x31de6f0937291f0981cfa8bd2e8cf09207d813e8de800cffff5a61991efedd4b) |
| 38 | move | Agent runs the cancelled m2 | refused, `TimelockUnexpectedOperationState(bytes32,bytes32)` | 30,621 | [`0x6170b34e…62dda4`](https://sepolia.basescan.org/tx/0x6170b34e810ce0a818d4901717e90cbc9f813fda6da634cdaac56267d462dda4) |
| 39 | move | A keeper runs o1: custody supplies 140 (150 of its 200 a day used) | succeeded | 254,057 | [`0x59e34f9e…fc156f`](https://sepolia.basescan.org/tx/0x59e34f9e2956e8787fde52a85af7d025a415c80ce36d3d343282d037a0fc156f) |
| 40 | move | O2 runs, a supply of 51 with 50 left of custody's daily 200 | refused, `ConditionViolation(17 AllowanceExceeded)` | 88,398 | [`0x3477fb39…bbd6b5`](https://sepolia.basescan.org/tx/0x3477fb396acad946af39fb32f2d1084cf2448f1a2f13f2f90676a5e156bbd6b5) |
| 41 | move | A keeper runs o3: custody withdraws 5 to itself | succeeded | 242,987 | [`0xa1e45b1c…af904f`](https://sepolia.basescan.org/tx/0xa1e45b1cdb3d7a6ccae0da44e3bcbbb69ed8f5271c25d69a85b985f2e1af904f) |
| 42 | move | X1 runs, a supply on behalf of a stranger | refused, `ConditionViolation(7 ParameterNotAllowed)` | 90,821 | [`0x7b488925…d144fe`](https://sepolia.basescan.org/tx/0x7b4889254ac531da5923c9d268919022f8d778bded4dfb7a16885fc3b9d144fe) |
| 43 | move | X2 runs, a withdrawal to a stranger | refused, `ConditionViolation(7 ParameterNotAllowed)` | 77,168 | [`0xce68b01b…1330fd`](https://sepolia.basescan.org/tx/0xce68b01bfe92e2b96237e98466004b282fd0671e5dc74399b939da8fa31330fd) |
| 44 | move | X3 runs, a USDC transfer out of custody | refused, `ConditionViolation(3 FunctionNotAllowed)` | 49,371 | [`0x1b47da86…2f320a`](https://sepolia.basescan.org/tx/0x1b47da865accd25bb13c40d4ad658e8cc8360b7d15798ef4c1c5991d7d2f320a) |
| 45 | move | X4 runs, an approval to a stranger | refused, `ConditionViolation(7 ParameterNotAllowed)` | 68,015 | [`0x2b5d4fb7…f69788`](https://sepolia.basescan.org/tx/0x2b5d4fb710fa1d650d379798f082fcbac3d911273f59714333c7a5372bf69788) |
| 46 | move | X5 runs, an aUSDC transfer | refused, `ConditionViolation(2 TargetAddressNotAllowed)` | 47,069 | [`0xf2bff39a…d1d73a`](https://sepolia.basescan.org/tx/0xf2bff39a812f3da7d8fee9f561a950dc8411cbfc4ba602a002d6e2a864d1d73a) |
| 47 | move | X6 runs, a borrow against custody's position | refused, `ConditionViolation(3 FunctionNotAllowed)` | 50,080 | [`0x7abae1b7…351179`](https://sepolia.basescan.org/tx/0x7abae1b7aecd2906e56aad4f20a17bedd33a16e8634abd2256bdae0ca1351179) |
| 48 | move | X7 runs, a delegatecall from custody | refused, `ConditionViolation(1 DelegateCallNotAllowed)` | 50,279 | [`0xf9068eb5…af8237`](https://sepolia.basescan.org/tx/0xf9068eb59f104b0bf03148fa7e88bc3601e8dc0938bf5763b7e576b09baf8237) |
| 49 | move | X8 runs, an owner added to custody | refused, `ConditionViolation(2 TargetAddressNotAllowed)` | 47,045 | [`0x977ecdc7…06562b`](https://sepolia.basescan.org/tx/0x977ecdc7076071c330562ed548924b4475f497ce06b4bd18238ac5910506562b) |
| 50 | move | X9 runs, a gate rule changed through the gate | refused, `ConditionViolation(2 TargetAddressNotAllowed)` | 48,010 | [`0x17f39fdf…1ca9a4`](https://sepolia.basescan.org/tx/0x17f39fdf06fe2dd2a052db9229f8f1ba40ca72a32aa32189e30327e4b11ca9a4) |
| 51 | move | X10 runs, the recovery role used by the move timelock | refused, `NoMembership()` | 41,560 | [`0x4619f7a9…a4331e`](https://sepolia.basescan.org/tx/0x4619f7a90f1984180b5af535d145dbf6f70d852a28b622298f6cb98bfea4331e) |
| 52 | move | X11 runs, a gate rule written by the move timelock | refused, `OwnableUnauthorizedAccount(address)` | 38,488 | [`0xc7beaf4b…76a642`](https://sepolia.basescan.org/tx/0xc7beaf4b986c01aafd97b2514fe0fd963c7ce207f7c252db4008967a7076a642) |
| 53 | move | Kill switch: custody revokes the trading role (3 of 3) | succeeded | 90,887 | [`0x87f58e95…0de8eb`](https://sepolia.basescan.org/tx/0x87f58e950648d08acef4ba0455fae78962b8427eabf8af15442668ae550de8eb) |
| 54 | move | After the kill switch: agent runs m3 | refused, `NoMembership()` | 42,152 | [`0x7de202dc…8d4e4b`](https://sepolia.basescan.org/tx/0x7de202dca4db45c0060bfb312f3d5f1f97288cdc5a1b5742ab509627908d4e4b) |
| 55 | move | After the kill switch: x12 runs, a withdrawal to custody | refused, `NoMembership()` | 42,012 | [`0xc19e44bd…1368a0`](https://sepolia.basescan.org/tx/0xc19e44bdb6db706281bc7b36bf15fe0b5559bc29f40745d7c0d90d987f1368a0) |
| 56 | recover | A stranger runs the cancelled recovery r1 | refused, `TimelockUnexpectedOperationState(bytes32,bytes32)` | 30,041 | [`0x006226ee…562005`](https://sepolia.basescan.org/tx/0x006226ee480ee3cfff30355b0196be39fda808b4ffddb98198a11749a3562005) |
| 57 | recover | Recovery r2 with trading off: a stranger runs it, custody pays the trustee 20 aUSDC | succeeded | 196,045 | [`0x736fae22…2b4592`](https://sepolia.basescan.org/tx/0x736fae22731d30511770f6fca07e5302c5c9e01b2fa010680adf768c632b4592) |
| 58 | recover | Recovery r3 runs, the gate refuses to pay a stranger | refused, `ConditionViolation(7 ParameterNotAllowed)` | 67,735 | [`0x88830150…23ae19`](https://sepolia.basescan.org/tx/0x888301500f59dfb04dd1042a297b6ff352e841159051baf3e6c81dd8f523ae19) |
| 59 | recover | Full stop: custody disables the gate (3 of 3) | succeeded | 82,057 | [`0x22e23753…5249f3`](https://sepolia.basescan.org/tx/0x22e237538482f96bb9ff5736a1b120ea8540b5daa50c9975e68ba175d55249f3) |
| 60 | recover | Recovery r4 runs while the gate is off | refused, `Error("GS104")` | 86,014 | [`0x5bc294b0…18ba86`](https://sepolia.basescan.org/tx/0x5bc294b0a4573079e33e66ef6a95dbfb2cef133932c7798bf91361386018ba86) |
| 61 | recover | Two of three custody signers re-enable the gate | refused, `Error("GS020")` | 49,203 | [`0x4fdd6966…dde433`](https://sepolia.basescan.org/tx/0x4fdd69663c9468f081ba7a4a43e861af690dd4597d06b0a9e4d965d8ffdde433) |
| 62 | recover | One Prime owner schedules a move | refused, `Error("GS020")` | 56,255 | [`0x76c1102d…059032`](https://sepolia.basescan.org/tx/0x76c1102d63e65526e702c1d4c144d50308211dbfd2cb9c5604b5cbbde3059032) |
| 63 | recover | Restore: custody re-enables the gate and the trading role (3 of 3) | succeeded | 151,083 | [`0x12ccc0bf…a687c6`](https://sepolia.basescan.org/tx/0x12ccc0bfa17af0e1d067a8c3f8b14ebc06a2bf10816dc627639874d616a687c6) |
| 64 | recover | Agent runs m4 after the restore: custody supplies 10 | succeeded | 260,316 | [`0x2e326036…4f82dd`](https://sepolia.basescan.org/tx/0x2e32603602bbc351e4d4acef959b30f9c010f640239efd28ca96b8fef74f82dd) |

## Cost

64 transactions, 26 that succeed and 38 refused, used 12,583,811 gas. Base
charged 0.0000755 ETH of execution and 0.0004013 ETH of L1 data fee, as the
receipts report it, 0.0004768 ETH in all. The deployer's own transactions cost
0.0002954 ETH, and it sent 0.00015 ETH of gas money each to the agent and the
stranger.

## Altered configurations

Six changes to the line's configuration, each applied alone to
`script/RefLine.s.sol`, make `test/RefLine.t.sol` fail
([log](../scripts/evm-config-check/refline/mutants-2026-10-27.txt)): the Prime
account as the gate's trading member in place of the move timelock, the band's
target left open, the band's role left open, the band's operation left open,
custody without the canceller role on the move timelock, and the agent's cap
raised to 500.

## What it does not show

- **The daily refill:** both caps refill after a day; the line runs inside one
  day. `test/ConfigOnly.t.sol` moves the clock a day and shows the agent's cap
  refilled.
- **Production delays:** 120 and 300 seconds are test values. docs/evm.md
  suggests, for example, 48 hours for recovery.
- **A pre-sign read of the owners' batch:** the Prime owners' 16 moves were
  signed as built. `evm_review` reads such a batch before signing; it was not
  run here.
- **Safe 1.5.0 on chain:** the line used Safe 1.4.1; the fork test runs both.
