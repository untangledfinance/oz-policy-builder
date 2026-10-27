# Prime on EVM: the reference line

**Date:** 27 October 2026.
**Status:** run on an anvil fork of Base Sepolia. The run on Base Sepolia
itself is next: the throwaway deployer `0x00ccd1A17fD215d8104e712a220AbA6aA6D5F901`
is waiting for test ETH, and the same command with `MODE=live` runs the line on
chain and replaces this record. Until then every address and hash below exists
only on that fork, and a block explorer will not find them.
**Network:** anvil 1.8.4 forking Base Sepolia (chain 84532) through
`https://sepolia.base.org` at block 50,996,017. The fork carries the live Safe
1.4.1, Zodiac Roles v2.1.1 and Aave test-market contracts. Every key is a
throwaway made for this run and kept outside the repository; nothing touches
mainnet.
**Design:** [docs/evm.md](../docs/evm.md): a custody Safe (3 of 3) with a
Roles gate, a Prime account (2 of 3) with the agent's band, a move timelock as
the gate's only trading member and a recovery timelock as its only recovery
member. The move delay is 120 seconds and the recovery delay 300 seconds, test
values; the fork test uses 1 hour and 2 days.
**Record:** [refline/anvil-run.json](../scripts/evm-config-check/refline/anvil-run.json)
holds every transaction with its hash, block, time, gas and revert data, and
`referenceLine` in [deployments/evm-testnet.json](../deployments/evm-testnet.json)
the addresses.

## How it ran

```sh
cd scripts/evm-config-check
anvil --fork-url https://sepolia.base.org --port 8547 --chain-id 84532
KEYS=/path/to/keys.json bun refline.ts                 # MODE=anvil, RPC=http://127.0.0.1:8547
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
for the move delay, and before the recover phase for the recovery delay. It
refuses any chain but 84532.

The four simulations made 128 checks (setup 34, schedule 28, move 27, recover
39), the same 128 that `test/RefLine.t.sol` makes on each Safe version.

## The line

| Part | Address on the fork | Code |
|---|---|---|
| Custody Safe, 3 of 3 | `0x1a5b68Ad9802189d3960eb970004F5c3Bc5b8550` | Safe proxy, 171 bytes; singleton SafeL2 1.4.1 `0x29fcB43b…C762` |
| Custody gate | `0x160f9c7b55a01Cc9F39fCa01B60Dc42d9f003CD1` | ERC-1167 proxy, 45 bytes, of the Roles v2.1.1 mastercopy `0xF2964CE6…83D5` |
| Prime account, 2 of 3 | `0x5DCc413D025F28C29eFECCC5d410B133eD3baad6` | Safe proxy, 171 bytes; singleton SafeL2 1.4.1 |
| Band module | `0x4a448501A08C7529D112370EF304c7bB2C1e31B1` | ERC-1167 proxy, 45 bytes, of the same mastercopy |
| Move timelock | `0x75Cb7Cb7281192b59e9aC550f0D91177F44b7100` | TimelockController 5.6.0, runtime hash `0x56cf178a…507f` |
| Recovery timelock | `0x17BEFE1Bb2a4Cae942Ef0746Dac1E86DC99FaF0f` | TimelockController 5.6.0, runtime hash `0x56cf178a…507f` |
| Agent | `0xBA70a9A88205d23cBf83332a98134882E965C2E6` | a key |
| Trustee | `0x0559025737F5AE1cd53084D28dfdA02033367558` | a key |

No contract of ours is among them. The driver read each address's code after
the run: both Safes are proxies whose singleton is the canonical SafeL2 1.4.1,
the gate and the band module are 45-byte proxies of the Roles v2.1.1
mastercopy, and both timelocks' runtime hashes equal TimelockController as forge
1.8.4 builds it from `@openzeppelin/contracts` 5.6.0 (solc 0.8.28, `via_ir`, 200
runs). The timelock is the only code compiled for the line, and it is
OpenZeppelin's, unmodified.

## What the run shows

Each result below is the result `test/RefLine.t.sol` asserts, with the same
status.

- **The agent's move waits, then reaches custody:** the agent scheduled four
  supplies of 10 through its band (252,903 gas each) and nothing moved. After
  the delay it ran the first (302,177 gas): custody paid 10 USDC and holds the
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

| # | Phase | Transaction | Result | Gas | Hash |
|---|---|---|---|---|---|
| 1 | setup | T1a create the custody Safe (3 of 3) | succeeded | 283,428 | `0x1fa2be5800a32e74c0cc8e490e6fbe66b6e93c85f581946331b5b15295ad13d0` |
| 2 | setup | T1b create the Prime account (2 of 3) | succeeded | 283,428 | `0xba0cf7751ef52863f667527caa5afebf8c2a95810f08a0b391d8b162e3350d6b` |
| 3 | setup | Move timelock (TimelockController 5.6.0) | succeeded | 1,400,883 | `0xd3c645524ab9a1d7e427852c25d43c7c35d97789ed09cb5acba037bbd89c2a01` |
| 4 | setup | Recovery timelock (TimelockController 5.6.0) | succeeded | 1,400,895 | `0x6ed89f113bdc1bb4301038ddb24cdba9b5af49914e0ad999702ac5fae7afa304` |
| 5 | setup | T2 the Prime account sets up its Roles module and the agent band (2 of 3) | succeeded | 971,256 | `0x1fd358cf7303a8823375a6bb191a1332d9efaa06622cd46a0b7e6af5b80fb0db` |
| 6 | setup | T3 custody sets up the gate, its trading and recovery roles and its cap (3 of 3) | succeeded | 1,365,057 | `0xb3c0cbf09c1f0fd83b46a3cb09979d4f5c0c5d9300e8df89913c99fa76b20664` |
| 7 | setup | Aave faucet mints 1,000 test USDC to custody | succeeded | 87,890 | `0x977fe8b5f4e257178a245dfb33ff0a7c230473c291c80909605b89c0dd6ab166` |
| 8 | setup | Gas for the agent | succeeded | 21,000 | `0x844ea5470a1e9573f92fa18144c709653f34f3ec08dc961224d30ed351b29070` |
| 9 | setup | Gas for the stranger | succeeded | 21,000 | `0x0385fa0a81f3af16185abee798511023c345c309869874155a7408b7ca3b7e7a` |
| 10 | schedule | Agent schedules move m1: supply 10 | succeeded | 252,903 | `0x8409b661cf5c981ce9fa419a02743494782dfbbf819ce7968033e0c1f54f74f9` |
| 11 | schedule | Agent schedules move m2: supply 10 (custody cancels it) | succeeded | 252,903 | `0x8557c76581cd96ba6ed7fdf92df8f6103947f0a0d11d789de12f60b332aef238` |
| 12 | schedule | Agent schedules move m3: supply 10 (runs after the kill switch) | succeeded | 252,903 | `0xc33cae070e922de2e2a02d8ba01c614c8218376f3fa6f7286a3612fc09fd2fee` |
| 13 | schedule | Agent schedules move m4: supply 10 (runs after the restore) | succeeded | 252,903 | `0xd0ae7b292623c1669fcfc7593c83fcad73ea7071cb39f2d4f5a54626805288cd` |
| 14 | schedule | Agent schedules a supply of 100, over its band | refused, `ConditionViolation(9 ParameterGreaterThanAllowed)` | 165,948 | `0x3505c10ec7ed2ee0643c14211a688787281dd1399839d3340cdb322f122e2404` |
| 15 | schedule | Agent schedules a supply of 20 with 10 left of its daily 50 | refused, `ConditionViolation(17 AllowanceExceeded)` | 167,905 | `0x9a48c7d3fb94dde852c7a0fabf026930cde3eb666e54b01224cab4cc2640b95d` |
| 16 | schedule | Agent schedules a supply of another asset (aUSDC) | refused, `ConditionViolation(7 ParameterNotAllowed)` | 163,487 | `0x1954bb83c1918654c3e45d42e09665af09ddabe68892ed386e29b0ce8d16ec19` |
| 17 | schedule | Agent schedules a withdraw, a call its band does not list | refused, `ConditionViolation(15 BitmaskNotAllowed)` | 172,091 | `0x1c7a4b5feb5fbf273c9e7b1db5747b101ebaf1fc0b493aee1ae3fa9abe6871a9` |
| 18 | schedule | Agent schedules a USDC transfer, a call its band does not list | refused, `ConditionViolation(7 ParameterNotAllowed)` | 157,801 | `0xd031d4e4a0d4527c349396d141493ab34689462ee3339e362c49bc5f9133c7e7` |
| 19 | schedule | Agent schedules a supply at an off-list target | refused, `ConditionViolation(7 ParameterNotAllowed)` | 158,297 | `0x565bce783e800881326d4a8514cadc31282690522352bcc00fca0605cd3c73f2` |
| 20 | schedule | Agent schedules a call to the custody Safe instead of the gate | refused, `ConditionViolation(7 ParameterNotAllowed)` | 153,112 | `0x967810eb4c809fb3437a98ffcfdebdfb1e3318a083295577e02cef13f1d82bbd` |
| 21 | schedule | Agent schedules a supply under the recovery role | refused, `ConditionViolation(7 ParameterNotAllowed)` | 175,149 | `0xd4a6ea2c9a4382f27f1731b55134a9583f0bed75c0e1506048d220248a8a543a` |
| 22 | schedule | Agent schedules a delegatecall from custody | refused, `ConditionViolation(7 ParameterNotAllowed)` | 173,633 | `0x3e39649474eaee35991e0426f69ace749fdc86ccfc7709f541aa60a48ad436d9` |
| 23 | schedule | Agent calls the move timelock's execute through its band | refused, `ConditionViolation(3 FunctionNotAllowed)` | 42,499 | `0xd53d5cb889f0c3bb5ca0d7581f75489972e4f88b56466e8a3c6b07e0eafdd191` |
| 24 | schedule | Agent schedules on the move timelock directly | refused, `AccessControlUnauthorizedAccount(address,bytes32)` | 30,860 | `0xdba1096b9c6eb030ccdb01dc8f29e15ef1fb4e13a63e9d3466cd80cb13636987` |
| 25 | schedule | Agent calls the gate directly | refused, `NotAuthorized(address)` | 33,108 | `0xd7e7b3e7159e968b4daf06666932c79f397ff39d7638843e4b9e84e30743ccc6` |
| 26 | schedule | A stranger uses the agent band | refused, `NotAuthorized(address)` | 36,021 | `0xba10551bac6f72c96a1398ed7899c2ea61b6598483f2dd2b5b9241ed11dc9aa7` |
| 27 | schedule | Agent runs m1 before the delay | refused, `TimelockUnexpectedOperationState(bytes32,bytes32)` | 30,641 | `0xc2be8c77962e8ebd7cecf05180bc3b3575d1c17fd131371a2cc2473cd8466621` |
| 28 | schedule | Prime owners schedule 16 moves in one transaction (2 of 3) | succeeded | 759,312 | `0x8b9a5e516399711f7c360936b85c54661f963c600549666f78d0828299813b8b` |
| 29 | schedule | Custody cancels m2 during the wait (3 of 3) | succeeded | 80,737 | `0xae7122e206d31487ef6e767cf189dd2fb08e9f2fdf8ab5a66809aacf0b7b19b6` |
| 30 | schedule | A stranger schedules a recovery | refused, `AccessControlUnauthorizedAccount(address,bytes32)` | 29,560 | `0x7de425adfeec88c561fdf2f1a0cb3e5e0b5753a2f6b0e5b37035412ba50a6b3a` |
| 31 | schedule | Prime owners schedule recoveries r1 to r4 in one transaction (2 of 3) | succeeded | 243,457 | `0x029a0bb13d6a7ac7a9315bb0590b3eb682878de631dc61e9a6b01d1dcb1fa5eb` |
| 32 | schedule | A stranger runs recovery r2 before the delay | refused, `TimelockUnexpectedOperationState(bytes32,bytes32)` | 30,073 | `0xdcb82d5c0b30985f4ed0d38ce0aefb6a0848ae40203c2d89b8d93099a59ca55e` |
| 33 | schedule | Custody cancels recovery r1 (3 of 3) | succeeded | 80,737 | `0x60e5233b0729f8ed20c2d2eb744e9d827bc83c02a305bb8089074445fbf760d4` |
| 34 | schedule | A stranger sets the move delay to 0 directly | refused, `TimelockUnauthorizedCaller(address)` | 21,632 | `0xa5eed0eaab3f88afc1749e2cd91b746a1a20bd3a78af4b7b53f4a4267e1526ed` |
| 35 | schedule | A stranger schedules a move delay of 0 | refused, `AccessControlUnauthorizedAccount(address,bytes32)` | 25,283 | `0x7018ebe2ef8f61943077d51aca4ff4143e910eca5f282735ff55f5f5eacfe122` |
| 36 | move | A keeper runs o-approve: custody approves the pool for 1,000 | succeeded | 124,867 | `0xc6d5aaa10deffc01f23674081f25a01ecde19f11c69ad266035e684fff83f0ea` |
| 37 | move | Agent runs m1: custody supplies 10 to the pool | succeeded | 302,177 | `0x5f59ff2277c1fb038427c2dd9134a8902675cb3c12c3fa33404ebb60c66db5d4` |
| 38 | move | Agent runs the cancelled m2 | refused, `TimelockUnexpectedOperationState(bytes32,bytes32)` | 30,597 | `0x28a27e98d49e1a24720dc05157258677c1496077c832c29bf39941bb320536ff` |
| 39 | move | A keeper runs o1: custody supplies 140 (150 of its 200 a day used) | succeeded | 260,292 | `0x3c055edc27ed467a0482525c3b5cfed5cc5aa66ddddd9404be32222d01d0c2a8` |
| 40 | move | O2 runs, a supply of 51 with 50 left of custody's daily 200 | refused, `ConditionViolation(17 AllowanceExceeded)` | 88,374 | `0xdf4f0658e3b67490f62d5588b25474fb68cf7e87c42591bb7468feede890feca` |
| 41 | move | A keeper runs o3: custody withdraws 5 to itself | succeeded | 242,963 | `0xb1f5db6291904783438b0816328d11b5e6ebf0fac477ec7f2d2b2d49a7eaffbf` |
| 42 | move | X1 runs, a supply on behalf of a stranger | refused, `ConditionViolation(7 ParameterNotAllowed)` | 90,809 | `0x309eb4c1e9758b9177ba31a3dd6ffc8e971a129443f26815e7bfe4f5d033798b` |
| 43 | move | X2 runs, a withdrawal to a stranger | refused, `ConditionViolation(7 ParameterNotAllowed)` | 77,156 | `0x2146fddf4bd7532fe957dc8f1dfb957f723b01ac746fdf0239768a93a9728b32` |
| 44 | move | X3 runs, a USDC transfer out of custody | refused, `ConditionViolation(3 FunctionNotAllowed)` | 49,359 | `0x82bef70a40a48318db716100ab9ea9e267d77b9112ec96880d6a859e39d13c2c` |
| 45 | move | X4 runs, an approval to a stranger | refused, `ConditionViolation(7 ParameterNotAllowed)` | 68,003 | `0x83592dee9cbd04ed9e810ed9ebafc106e6d68e38e76039d63f509c4e645b88dd` |
| 46 | move | X5 runs, an aUSDC transfer | refused, `ConditionViolation(2 TargetAddressNotAllowed)` | 47,057 | `0x27df0e3dbd7d73581b1d35f69e3818f15523521a4e40a6ac0434e1259ec713f8` |
| 47 | move | X6 runs, a borrow against custody's position | refused, `ConditionViolation(3 FunctionNotAllowed)` | 50,056 | `0x5040f241a89227b027609f58cca70408852d375b7b43ef8f223856a1de47d5db` |
| 48 | move | X7 runs, a delegatecall from custody | refused, `ConditionViolation(1 DelegateCallNotAllowed)` | 50,255 | `0xdbc096934ddb8a4bde677f43f7398e6f1fd91a3ac50efccdae301d97bf5df86e` |
| 49 | move | X8 runs, an owner added to custody | refused, `ConditionViolation(2 TargetAddressNotAllowed)` | 47,021 | `0xd1c2f3a6370238468bd03db5ae6cdbdea766e28ebe89f48987700fee79ad997c` |
| 50 | move | X9 runs, a gate rule changed through the gate | refused, `ConditionViolation(2 TargetAddressNotAllowed)` | 47,986 | `0xe1eba72c27af6c90b89c37e3875f48dda23aca0e7fa589e314fed1c1ae6f4e9c` |
| 51 | move | X10 runs, the recovery role used by the move timelock | refused, `NoMembership()` | 41,548 | `0xf85e9ddd67ed5f19e3a0fe222b200c52d41a194e9635e8e2c6fb31525693ac62` |
| 52 | move | X11 runs, a gate rule written by the move timelock | refused, `OwnableUnauthorizedAccount(address)` | 38,476 | `0xd95d11203e956398cc5f960e8e8a16dac6ea995db537618575b8b654ccd55ddf` |
| 53 | move | Kill switch: custody revokes the trading role (3 of 3) | succeeded | 90,875 | `0xb63d02e24fac033c36d9fcd9373722f49f480900ca4655e94fb93ecead517aed` |
| 54 | move | After the kill switch: agent runs m3 | refused, `NoMembership()` | 42,128 | `0xe705470be682f8884866747e2c873eb3a1dfaa9fe0f75b985c68197d06befa4a` |
| 55 | move | After the kill switch: x12 runs, a withdrawal to custody | refused, `NoMembership()` | 41,988 | `0x173e07ba2fc42ef8722d4a6290950d5e5faf9a1c10cf783f1defe56e472ce922` |
| 56 | recover | A stranger runs the cancelled recovery r1 | refused, `TimelockUnexpectedOperationState(bytes32,bytes32)` | 30,029 | `0xbc78cb3451a82a26b4cdfb20c74cae8608f4c6a38af95cbe3f0a51bc80849c34` |
| 57 | recover | Recovery r2 with trading off: a stranger runs it, custody pays the trustee 20 aUSDC | succeeded | 196,033 | `0xba189ebd99e98f5c276816ef2be1aea88e75c9f272ea79fe21a876acfee90924` |
| 58 | recover | Recovery r3 runs, the gate refuses to pay a stranger | refused, `ConditionViolation(7 ParameterNotAllowed)` | 67,723 | `0xa68879f67c881f1be2c158822c3a6fcd152e3e84416f02e303e123e96195cd8a` |
| 59 | recover | Full stop: custody disables the gate (3 of 3) | succeeded | 82,033 | `0xd8b2e48a305c75bbe27996d4881c2e5417308f1efa90d8d311ff05dd39105f60` |
| 60 | recover | Recovery r4 runs while the gate is off | refused, `Error("GS104")` | 86,002 | `0x19cb36623db17eda79563dbe17ed6ae6d5f7a599f1d52df1bf0eece21ac25c19` |
| 61 | recover | Two of three custody signers re-enable the gate | refused, `Error("GS020")` | 49,179 | `0xde4b9c02522a290f07b2527e3f13d7c7995d3471882e30b47bfa28e1f5164c2d` |
| 62 | recover | One Prime owner schedules a move | refused, `Error("GS020")` | 56,243 | `0x108d82c288a468fa07fdc8de9785552a4d03cee225869549e38ecaae59f87a8e` |
| 63 | recover | Restore: custody re-enables the gate and the trading role (3 of 3) | succeeded | 151,095 | `0xd98c9733d2010731d9ee48944b833bffc4d8e0c9c0e23933597eeb97b2247cfa` |
| 64 | recover | Agent runs m4 after the restore: custody supplies 10 | succeeded | 260,292 | `0xe8ad36e9da428722b9a18e7f98b2af88db46479959f44370659ac968251c5bad` |

## Cost

64 transactions, 26 that succeed and 38 refused, used 12,588,408 gas. At the
fork's base fee of about 0.005 gwei and a tip of 0.001 gwei that is 0.0000710
ETH of execution. Base also charges an L1 data fee, which anvil does not; the
driver priced each signed transaction with Base's `GasPriceOracle.getL1Fee` on
the fork, 0.0002458 ETH in all. The deployer's own transactions come to about
0.00018 ETH, and it sends 0.00015 ETH of gas money each to the agent and the
stranger, so a deployer with 0.001 test ETH runs the line on Base Sepolia with
room for the L1 fee to move.

## What it does not show

- **Base Sepolia itself:** the run is on a fork, at the fork's clock. The live
  run waits for test ETH.
- **The daily refill:** both caps refill after a day; the line runs inside one
  day. `test/ConfigOnly.t.sol` moves the clock a day and shows the agent's cap
  refilled.
- **Production delays:** 120 and 300 seconds are test values. docs/evm.md
  suggests, for example, 48 hours for recovery.
- **A pre-sign read of the owners' batch:** the Prime owners' 16 moves were
  signed as built. `evm_review` reads such a batch before signing; it was not
  run here.
