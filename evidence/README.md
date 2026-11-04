# Audit evidence

The logs and records behind the claims in the docs and in
[stride-threat-model.md](stride-threat-model.md). Unless a row says otherwise,
each was produced on 20 October 2026 from the tree of that date, with the
contract builds then pinned: policy interpreter `810f53f1…`, custody gate
`b01024f3…`, execution adapter `4985cd12…`, `prime-seat` `393f0e5d…`. This tree
pins interpreter `6704996f…` and adapter `bf85432c…` in
`contracts/build-hashes.json`; the gate and the seat are unchanged.
Every network run is on Stellar testnet with throwaway keys made for that run
and funded by friendbot; the keys never leave the run.

## Index

| File | Command | Result |
| --- | --- | --- |
| `stride-threat-model.md` | STRIDE pass over every component in the tree | threats by component with an ID per threat, the control at file and line, how each was checked, the open items by severity and the residual risks |
| `executor-binding-testnet.log` | the executor-binding probe, run from our build host. The probe is not in this repository, so the log cannot be regenerated from the tree; its transaction ids can be read back on testnet. `contracts/stellar/policy-interpreter/oz08/` runs most of the same cases on the 0.8.0 account in the test host: the keyless `run`, the binding, 3017, 3004, 210 and 204. It has neither the no-gate adapter rows (n8a to n8e) nor the misstated scope (n5b, n5c): the adapter's unit tests and `execution-null-gate-testnet.log` cover the adapter with no gate, and `policy-interpreter/tests/keyless.rs` covers the 221 pin at each checkpoint, a misstated scope included | 27 of 27 rows as expected on an OpenZeppelin 0.8.0 account and a fresh interpreter instance: keyless `run` works; a keyless `execute`, `cancel` or direct venue call is refused; adapter-signed rules fail 3017; `remove_policy` on a keyless rule fails 3004; unpinned self-scoped rules fail 221 at `bind_executor`, at an install under a binding and in `enforce`; the venue rule works through the binding; an adapter with no gate satisfies no binding. Every refusal also failed on chain, with its transaction id |
| `execution-wait-testnet.log` | `bun scripts/verify-execution-wait-testnet.ts` | 45 of 45: a Blend supply at once and stored; stored batches run later by an account with no role; the run rule's refusals; an agent's rule demanding its own minimum wait; cancels by the Prime and custody and refusals for anyone else; runs early, twice, after a cancel or after the window refused; the adapter's floor; the Prime creating the adapter at custody's address with other numbers refused |
| `execution-address-rule-testnet.log` | `bun scripts/verify-execution-address-rule-testnet.ts` | 35 of 35: a Blend supply, a withdrawal to custody and an Aquarius swap succeed; a stranger in any argument, nested value, strkey, raw 32 bytes or authorisation, a pull to the gate itself, a token custody never approved, a batch calling the Prime, a deploy authorisation and a Prime-signed rebind are refused; custody rebinding to a non-gate is refused |
| `execution-null-gate-testnet.log` | `bun scripts/verify-execution-null-gate-testnet.ts` | 69 of 69, for a G account and an OpenZeppelin Prime: a bundle of three calls with one authorisation; an agent's bundle at its cap; refusals for a failed call (nothing moves), an expired entry, a call to the Prime, a grant, any wait, `rebind`, a stranger's `cancel`, an agent over its cap or citing its adapter rule for a token, and a pull through custody's gate; then the cost of 1, 3 and 10 calls with and without a gate |
| `nogate-liquidation-testnet.log` | the no-gate liquidation probe, 25 October 2026, run from our build host (probe kept off the repository like the executor-binding probe; `contracts/stellar/policy-interpreter/oz08/tests/nogate.rs` runs the same cases in the test host on the real wasm and account) | 24 of 24 rows as expected on an OpenZeppelin 0.8.0 account (`8286422f…`, OZ `v0.8.0` tag `ddc327e`), a fresh interpreter instance from `6704996f…` and adapters from `bf85432c…`: a stranger liquidates alone through the no-gate adapter under keyless bound rules; every grant that is not the adapter's exact word is refused 3; a missing word, a direct ask after the run and a gated adapter fail at the binding; a replayed entry fails on its nonce; a root rule without the batch shape fails 221 at bind, at an install under the binding and in `enforce`; off-shape batches, an insider, a high y, a large R and a healthy position fail 100; a wait fails 10 and `run` 5; the adapter-signed liquidate rule fails 3017; an agent's keyed batch with no words runs. The E-36 hazard (a keyed door without the grants pin) is shown in `oz08/tests/nogate.rs`, not on testnet. Every refusal also failed on chain, with its transaction id. Section 6.7 of the threat model |
| `nogate-liquidation-mutants.log` | 32 mutants of the no-gate word (adapter) and the batch pin (interpreter), each applied alone and the relevant suites run | 31 killed; the survivor (A5) is equivalent, since the deploy variant is refused twice, and the mutant that removes both (A5b) is killed |
| `oz-0.8.0-migration-testnet.log` | the OpenZeppelin `v0.8.0` migration, 26 October 2026, run from our build host (probe kept off the repository like the executor-binding probe); the builds, deploys and TTL extensions it relies on are in `deployments/oz-accounts.json` and `deployments/oz-policies.json` | 29 of 29 rows as expected (12 on the 0.8.0 account, 5 and then 12 on a 0.7.2-line one), plus the `policy-synth` before and after. On the 0.8.0 testnet reference account (`CDS2W673…`, `8286422f…`) through `CDER6P73…`: every instance runs its recorded code; a keyless rule pair bound to a dedicated no-gate adapter moves 0.5 XLM for a stranger, 2 XLM fails 100, an unbound keyless rule fails 210; the `v0.8.0` `spending_limit` permits 1.5 of 2 XLM and refuses 1 more (3221); `simple_threshold` 2 refuses one signer (3202) and permits two; `weighted_threshold` refuses the weight-1 signer alone (3213) and permits the weight-2 one. The same rows pass on a 0.7.2-line account (`91a2cd56…`), the `v0.8.0` policies included. `install_policy` on the 0.8.0 account fails at 5.1.0 (`Error(Auth, InvalidAction)`: it signed the 0.7.2-line digest) and lands at 5.2.0 (the 0.8.0 preimage), as do the 0.7.2-line control and a `revoke_policy` |
| `oz-threshold-live.log` | `bun packages/policy-synth/scripts/live-threshold.ts`, then with `WEIGHTED=1` | `simple_threshold(2)` beside the interpreter: signer A alone refused 3202, A and B together permitted (transfer sent). With `WEIGHTED=1` (A:2, B:1, threshold 2) `install_policy` refuses the rule before any transaction, because A alone meets the threshold |
| `contract-gate.log` | `cargo fmt --check`, `clippy -D warnings`, `cargo test` per crate and in `oz08/`, conformance in release, each `build-wasm.sh` and its hash check | every step passed: interpreter 416 tests (its 18 conformance cases again in release), `oz08/` 12, adapter 62, gate 3, `prime-seat` 21; each rebuilt wasm equals its pin, and `test-blend-pool` built with the same path remaps gives `7ba261ed…` |
| `offchain-gate.log` | `bun run check`, the three package builds, `bun run typecheck`, `bun test`, `bun run test:isolated`, 21 October 2026, after the lockfile update and the MCP input cap | every step passed: biome 0 errors (36 warnings), typecheck clean, `bun test` 1,782 pass and 0 fail, isolated 1,758 + 6 + 18 |
| `worst-case-ceilings.txt` | `cargo test --release --test worst_case -- --nocapture` on the interpreter wasm | every rule shape at each limit set stays at or under 80% of the testnet limits; worst case at the ceilings: `install` 64.7M CPU, `enforce` 62.3M CPU and 1.58 MB; 8 wasm reads cost 12.7 MB of memory for one context and about 11.4 MB for each further one |
| `soroban-network-limits-2026-10-16.txt` | `getLedgerEntries` on every `CONFIG_SETTING` key, testnet, 16 October 2026 | the per-transaction limits `tests/worst_case.rs` holds every rule shape to, at 80% |
| `cargo-audit.log` | `cargo audit` in the interpreter crate | no vulnerability across 202 crates on 20 October; since 23 October RUSTSEC-2026-0387 (`crypto-bigint` 0.5.5) is ignored with its reason in `contracts/stellar/policy-interpreter/.cargo/audit.toml`: host-side only, not in the wasm (finding 1); one unmaintained-crate warning |
| `bun-audit.log` | `bun audit`, 21 October 2026, after the lockfile update | no vulnerability (finding 2) |
| `clippy-pedantic.log` | `cargo clippy --all-targets -- -W clippy::pedantic -W clippy::nursery` in the interpreter crate | 352 distinct style warnings, 68 in contract source and 284 in tests; every cast, panic, unwrap, indexing or overflow lint is in test code |
| `scout-audit.log` | `cargo scout-audit` in the interpreter crate (see below) | run on 27 August 2026 at commit `5bae0a8`: 0 critical, 9 medium, 0 minor, 1 enhancement; triage in finding 3. On this tree Scout 0.3.16 stopped while building its own detector helper on our build host, so the August log stays |
| `stateless/execution-testnet.json` | `scripts/stateless-execution-testnet.ts` at `a40ed75` (since removed), 16 September 2026 | a testnet run of an earlier stateless execution design, built from `47df478`: its interpreter `CBIQGAHI…`, a per-Prime adapter and a test Prime, their wasm hashes and rules, and 30 transactions |
| `stateless/execution-testnet-verification.json` | `bun scripts/verify-stateless-testnet.ts`, read only and keyless | each of those 30 transactions read back with its status and ledger, the instances, and balances, allowances and the Blend position at zero. The script asks `soroban-testnet.stellar.org`, which keeps about seven days of transactions, so a rerun now needs an RPC with full history; Horizon still has them (`537b95ee…` succeeded at ledger 4,706,459, read on 19 October 2026) |

## The 6.0.0 fixes (preliminary review), 2 November 2026

The logs above were produced before these fixes. The 6.0.0 builds were rebuilt with each crate's `build-wasm.sh`
and reproduced the integration hashes exactly:

| Contract | sha256 | Size | Upload on testnet |
|---|---|---|---|
| Policy interpreter | `c6273cb1880233c541e67592a687d01b309b15ce2c41158d043f50cce96955e5` | 84,280 | [`f9d6bffb…`](https://stellar.expert/explorer/testnet/tx/f9d6bffb67d6d57dd36e382c003a001db91095367284e41f215713e851e063a5) |
| Execution adapter | `eafcd011a3c2e0aae08402e9fbd5f39e65d1feb370e45035ee20a25d4c95b725` | 31,667 | [`f3a65ae1…`](https://stellar.expert/explorer/testnet/tx/f3a65ae12118f92e2e04c16ee551150008be2d3391ddabdef1518f434a6511cc) |
| Custody gate | `89e48fcb5c9f037f1d702d2cb6ed3be99f24a7794c0f5df712b7ba887db50dbb` | 13,205 | [`2b1c2c4e…`](https://stellar.expert/explorer/testnet/tx/2b1c2c4ef1a27f7a82b6b5d5821ec8fdc5ff39f2869a02d075179b490ff80d23) |
| Prime seat | `f39587ad8a190e31955a6fab1c274372fa724180c4ab1bad72846e08f1f2bd51` | 19,758 | [`fb4d4210…`](https://stellar.expert/explorer/testnet/tx/fb4d42109961c374f6d4a53ef7e22456fde600f969dddfd07b902cd4bfc737bf) |

All four fit the network's `CONTRACT_MAX_SIZE_BYTES` of 131,072 on testnet.
The run used throwaway friendbot keys on new addresses; the records are the
`testnetVerification` blocks of
[`deployments/interpreter-testnet.json`](../deployments/interpreter-testnet.json)
and [`deployments/execution-testnet.json`](../deployments/execution-testnet.json).
Fresh instances: interpreter `CADKAYWU…` ([`f43d3dbd…`](https://stellar.expert/explorer/testnet/tx/f43d3dbd9e4f5854cd52f8324c1ccab3e707e7252a538e27f144dc1f97d30784); `grammar_version()` 7, limits reads 8, leaves 400, bytes 24,576, elems 32, `in` 32, depth 5), an OpenZeppelin 0.8.0 account `CBDL3KAJ…` ([`5bf23782…`](https://stellar.expert/explorer/testnet/tx/5bf2378215cd87ed35dfd666d592782d7043b2cca23977c07bc43c9b3c26f146), code `8286422f…`), a no-gate liquidation adapter `CC7FBJKH…` ([`f57ad38f…`](https://stellar.expert/explorer/testnet/tx/f57ad38f219848b578b486f057056954a8c563748610b139545096205211bbd6)), a gate whose `payees` leave the interpreter out `CC5OXLYQ…` ([`322e66c9…`](https://stellar.expert/explorer/testnet/tx/322e66c9c192db18d40931dfdd14fc0435161ebd24fb2f0536596f4cf5f78c78)) with its gated adapter `CD3HJFX7…`, a second gate `CCZDKGQX…` (payees `[SAC, payee, prime]`, `allowed` also listing the interpreter; [`53f5acf5…`](https://stellar.expert/explorer/testnet/tx/53f5acf5d7e27fcf9723c073b16508201016ec1ccfc8a4d4c47bcbe662f19d72)) with its gated adapter `CB7JBRA5…`, a test asset SAC `CDYGYHZT…` and a seat `CAU2MFRT…`. The interpreter constructor refused five out-of-range limit sets with 220 in simulation. The account, the no-gate adapter and both gated adapters were deployed through the account's own authority (`createCustomContract` under rule 0), so the patched contracts run under OpenZeppelin's 0.8.0 account with no ABI break.

**Verified on chain** (each refusal confirmed in simulation, each permit submitted and confirmed; codes are `Error(Contract, #N)`):

| Fix | Result | Transactions |
|---|---|---|
| Executor 222 | `bind_executor` with the account as executor refused 222; with the interpreter refused 222; with the no-gate adapter permitted (version 2) | install [`3ac8c069…`](https://stellar.expert/explorer/testnet/tx/3ac8c06900b916a534a0254455c82bbf08597a980fedf383f4cb0fc80d728181), bind [`e7a1e344…`](https://stellar.expert/explorer/testnet/tx/e7a1e3448b269e0a94e55a12a42f68dd6d6f74923d324d81aa650e6e54a99c84) |
| Version counter | install with nonce 2 on a fresh rule refused 202; nonce 1 permitted; bind at counter + 1 permitted; the same bind replayed refused 202; `uninstall` signed over `(key, 3)` permitted; re-install with the stale nonce 1 refused 202; re-install with nonce 4 permitted | [`07eb3eb0…`](https://stellar.expert/explorer/testnet/tx/07eb3eb06564279c9abb534faf3b2cbde085e44cce3e667380f1fa04009fea03), [`3d4578a0…`](https://stellar.expert/explorer/testnet/tx/3d4578a02a57dffc131f4cc9f29ce8e03b2c5833cf83e7df1ea8ef20ec0a5b9a), [`a1c22bd1…`](https://stellar.expert/explorer/testnet/tx/a1c22bd17d638f8be61016ce7a81159d2c6545e99fa6cac1fd032132858591a5), [`281c04d6…`](https://stellar.expert/explorer/testnet/tx/281c04d6a4dd32eb9988da6e35df9c3ce68d0e6e201e78ba356f5eb4b2e063ed) |
| Grants count at bind | a keyless self-scoped `execute` rule with `eq(call_arg_len(1), 0)` installs and binds; the same rule without the pin installs (install does not check the pin) and its `bind_executor` is refused 221 | install [`dc7775a9…`](https://stellar.expert/explorer/testnet/tx/dc7775a9745a950158eb93f7c70ab4ee5bc317829a2d31914b0b3e607e8d3a68), bind [`97c30f36…`](https://stellar.expert/explorer/testnet/tx/97c30f3686251745260a7ba62cfdb5567e8f023ccdf242f2d180c5b5174083a6), unpinned install [`76fea75f…`](https://stellar.expert/explorer/testnet/tx/76fea75f2295e9ecf3f9d12b180b151f938da8c6034c0f2d14e27c864f6784b1) |
| Grants count at `enforce` (headline) | on the fresh OpenZeppelin account, a root rule pinning an immediate `execute` of one `transfer` with `eq(call_arg_len(1), 1)`, and an inner rule for the token. The batch with one grant is permitted and moves 1 TST; the same visible call with one extra grant (`call_arg_len(1)` 2, pin 1) is refused 100 (`ArgMismatch`): the pin fires and nothing else differs | rules 1 and 2: install `fd68a903…` and `fa088ea8…`, bind `8907bd65…` and `6eb2c474…` (short forms; the full hashes are in the verifier's run log, which is not in this repository); permitted batch [`8b1ee673…`](https://stellar.expert/explorer/testnet/tx/8b1ee67312c68891123c6d94adaba6b88a93c71b422ff355b6df50014c3179a9) |
| Follower commitment at bind | a keyless follower of rule `(G, 11)` scoped to the executor installs and binds, recording the digest of the followed call targets and functions | install [`663ddcda…`](https://stellar.expert/explorer/testnet/tx/663ddcda2d547d4752f6d85306bdb0d482d36a794c8f8d53424228a70ffd1b8e), bind [`0be0335e…`](https://stellar.expert/explorer/testnet/tx/0be0335e0e7e1f13d67f7b807358dadd0cd679fc5bd39450a561bd873e8e7806) |
| No-gate word following another `execute` or `run` | `execute` with a grant whose followed context is another contract's `execute`, or its `run`, refused 3 (`Uncheckable`); a grant following an ordinary venue `transfer` passes `vouched` (control) | simulation |
| Gate `payees` | a gate whose payee is not on `allowed` refused 3 (`PayeeNotAllowed`); on the second gate, a gated batch naming the interpreter as a call target, or as a call argument, refused 2 (`AddressNotAllowed`); a grant whose policy context is the interpreter passes the address check; a control `transfer(prime, payee)` passes it | simulation |
| Events (interpreter, seat) | `Installed` (topics `["installed", account, 1]`), `ExecutorBound` (`["executor_bound", account, 1]`) and `Uninstalled` (`["uninstalled", account, 2]`) read from the transaction meta; the seat's `Granted` (`["granted", key]`) on the end below | the install, bind and uninstall transactions above |
| Seat generation, short and empty inputs | grant, then an end by the owner: the generation moves from 0 to 1 and `Granted` is emitted; the old end (signed over generation 0) refused (`Error(Crypto, InvalidInput)`); a `verify` proof under 96 bytes returns false; an empty rule-id list returns false, no trap | grant [`80234517…`](https://stellar.expert/explorer/testnet/tx/802345172d6da6ccc7c66bd622f74dd0904ea0a42b9021c465212a62b2806b7e), end [`f1babfbd…`](https://stellar.expert/explorer/testnet/tx/f1babfbdba23013198d0a0da6c9e7e72c4796434a770e1d4198060f236e5aaa4), seat deploy [`752b9215…`](https://stellar.expert/explorer/testnet/tx/752b921541d993d77833ab247c6b5ab2968b034eb7d1f674fbb48f36a8598acc) |

**Round 3: the remaining checks, driven on chain (3 November 2026).** A second set of fresh instances, again new addresses only: interpreter `CA6IGORH…` ([`754cc245…`](https://stellar.expert/explorer/testnet/tx/754cc2452f31118071923f139be85daed113a8c6d22ae9cc47517f44f4551a47)), an OpenZeppelin 0.8.0 account `CBWLXJUW…` ([`d0bf2b59…`](https://stellar.expert/explorer/testnet/tx/d0bf2b59dcdc93bd22481cd8a3f7c1f2747ec18d9c5e21e898b342d6a5d21d5b)), no-gate adapters `CCVJ3MRH…` and `CAKOME5E…`, a gate `CBWHQHCU…` with its gated adapter `CDGCMJAA…`, a successor gate `CBFURX2K…` (test-only: its payees include the interpreter and the first gate, so that the first gate's own check can be reached after a rebind), three test assets (`CCUWLFUD…`, `CBNRM6WY…`, `CD54ZPUZ…`) and the **Thief** `CANBKKPY…` (wasm `b55e6a03…`, upload [`f112c401…`](https://stellar.expert/explorer/testnet/tx/f112c401e23d7f19da73bf96e0c46f86e28b8151f95dac9d227b39c4a340337e)). The Thief is a test-only attacker contract: a contract-account payer whose `__check_auth`, once armed, raises an extra `transfer` from the victim account. Its source is kept outside this repository and it is not part of any release. The records are the `testnetVerification.round3` blocks of the two deployment files. Refusals are simulations in enforcing mode with the full authorisation entries; permits were submitted and confirmed.

| Fix | Result | Transactions |
|---|---|---|
| Grants count, contract-payer variant (the Thief) | On the account: a root rule (scope = executor, an immediate `execute` of `[TUSD.transfer(payer → account), XLMX.transfer(account → payer)]`, `eq(call_arg_len(1), 1)`) and an inner XLMX rule with no per-call bound. The batch with the Thief unarmed as payer is permitted. With the Thief armed, its callback's `transfer` context added to the account's entry and a second word for it (2 grants, pin 1), the batch is refused 100 (`ArgMismatch`, raised by the interpreter in the root rule); without the second word the extra context is refused (`Auth`, `InvalidAction`). Control: the same smuggle against a root rule pinned to the wrong count (2) runs, and the Thief takes 2,000 and 5 XLMX, so the pin is what stops it | root rule install [`9d699b3b…`](https://stellar.expert/explorer/testnet/tx/9d699b3b19eb37989374c19870b5ad16cb4bc3c74914f569d26c28b84f03f666), bind [`c8df1ad4…`](https://stellar.expert/explorer/testnet/tx/c8df1ad4e83747c1f5218f874853412425382028c14fed8af2444e8255dd597c); permitted batch [`dc070958…`](https://stellar.expert/explorer/testnet/tx/dc07095849c648aef27179197be6d503159db11c9e851b603cf2f25cfea0da1f); wrong-count control: install [`09f236cd…`](https://stellar.expert/explorer/testnet/tx/09f236cdb031c1b2dea049b265c3bcba8dea5d612e3d4c1ac1ac571274b9432e), bind [`cba28ed7…`](https://stellar.expert/explorer/testnet/tx/cba28ed769938fee697b21d906c0f04adf913de3d4e97c510a58ec10f7d9d23c), drain [`d164da45…`](https://stellar.expert/explorer/testnet/tx/d164da453563f71a884e1fab28490874810befc7bee9190d2234c5a5932c27e7) |
| Follower retarget at `enforce` | The followed owner is a separate account that re-installs its own rule `(G, 11)` on the interpreter under the same id with the next nonce; the follower is an ordinary account rule whose predicate is that reference (rule 6, scope = its executor, bound). The batch is permitted; an amount change by the owner still permits the batch with the new amount and refuses the old (100); a retarget of the call target by `eq` is refused 221, and by an `in` set that still matches the visible batch is refused 221; restoring the targets permits again | follower install [`3ff0f70a…`](https://stellar.expert/explorer/testnet/tx/3ff0f70a55def0d5756c47a28457c819cd88c828b74249925d511da5a512332a), bind [`19663eb1…`](https://stellar.expert/explorer/testnet/tx/19663eb1583f8969d34f0ba1c6bf33b53a869d27b073476b8bb22c8c61185a6b); permits [`9d5bf29f…`](https://stellar.expert/explorer/testnet/tx/9d5bf29fa847aee70a88154be95270ca421bc590b68b5c8b1fdfd231f5b31c0f), [`6a367784…`](https://stellar.expert/explorer/testnet/tx/6a3677849e0ac8af45114ee5c02b1aaaee7f8077568f6a44616e058bbe77ab2c), [`43388733…`](https://stellar.expert/explorer/testnet/tx/43388733c4468f7371ccc20eff2282323be151684045df980d461e42d591a49e); owner's re-installs (nonces 2 to 5) [`6976be19…`](https://stellar.expert/explorer/testnet/tx/6976be19fa5f49e687ad52ea4d83a9edffcacfb37d1ec41842831b1503440b84), [`6df949f8…`](https://stellar.expert/explorer/testnet/tx/6df949f89141e7ace62b2ecbe1c0ec8d061d9cd31fd9a54675d6dc79eedc51c3), [`07fbe757…`](https://stellar.expert/explorer/testnet/tx/07fbe7578ccf022ae32e4ecd98502929f6be2446990d565aeef47236fe8bb37e), [`b4236745…`](https://stellar.expert/explorer/testnet/tx/b42367453834c553b2378d0e9218a205ec99bbff16587dab54d215345c8efed2) |
| Gate `pull` | A batch through the gated adapter pulls 0.1 TUSD from custody to a payee: permitted (the payee goes from 0 to 1,000,000), `Pulled` emitted. A pull to the interpreter, or to a stranger, is refused 2 by the adapter's `payees` check. After a rebind to a successor gate whose lists admit the interpreter, the same pull reaches the first gate and is refused 1 (`DestinationNotAllowed`) by the gate's own `payees` check | pull [`216c538a…`](https://stellar.expert/explorer/testnet/tx/216c538acb78859fb858f387986c3d9f9a05654081de40d5f6be7ab408c42c52); rebind [`86fa078f…`](https://stellar.expert/explorer/testnet/tx/86fa078fb6cac8a68e7b15514e67b95151044f58ef226e5975223f22fcc43707) |
| Rebind floor | Batches 1 to 3 stored with a wait of 3; batch 2 runs before the rebind ([`241013b9…`](https://stellar.expert/explorer/testnet/tx/241013b94fbcc86fb1656506fbc87fb2fe5b1f529d903295f5bda7b6198d8fcb)) and a simulation shows batch 3 runnable; custody rebinds (`Rebound`, floor 3); batch 3 is then refused 5 (`NotScheduled`); a batch stored after the rebind (id 4) is checked against the successor gate and runs | stores [`d2b2f77e…`](https://stellar.expert/explorer/testnet/tx/d2b2f77e74a748bbde5124ebed5bb1d909e760a11efc65f65dff77d1f843f314), [`33787011…`](https://stellar.expert/explorer/testnet/tx/3378701103c1985875726f9e989ec3fb61895a5811192128160b7db6b7e80773), [`ce92c4f4…`](https://stellar.expert/explorer/testnet/tx/ce92c4f493c9e3c1d5ec1c83cb9b336d85501f9a05b8e63108d36934fc4674fb); rebind [`86fa078f…`](https://stellar.expert/explorer/testnet/tx/86fa078fb6cac8a68e7b15514e67b95151044f58ef226e5975223f22fcc43707); new batch [`3a66dbbf…`](https://stellar.expert/explorer/testnet/tx/3a66dbbf17aaa65a4b89082da61e0e31306fa97891c7b25a015766980c5ffd90), run [`bb6ee0ce…`](https://stellar.expert/explorer/testnet/tx/bb6ee0cec3a7c530e1f57194caf1ee052475629ed709ea726b01f6538feabe29) |
| Take-over run | Batch 1, stored on the gated adapter, calls the no-gate adapter's `execute` of one `TUSD.transfer(account → payee)`, with the words for both contexts as grants. It runs through `run(1)` under a keyless run rule, a keyless take-over rule scoped to the no-gate adapter and bound to the gated adapter, and an inner token rule bound to it (rule ids `[run, take-over, inner]`, tree `run → execute → transfer`); 0.1 TUSD moves from the account to the payee, and the same id again is refused 5 | store [`d2b2f77e…`](https://stellar.expert/explorer/testnet/tx/d2b2f77e74a748bbde5124ebed5bb1d909e760a11efc65f65dff77d1f843f314), run [`141f517a…`](https://stellar.expert/explorer/testnet/tx/141f517a78a494396d18c78a0401f562465db497e144d9cc13fad8814d45d337) |
| Adapter and gate events | Read from the transaction meta: `BatchStored` (`["batch_stored", 1]`, `run_at`), `Ran` (`["ran", 0]` for an immediate `execute`, `["ran", id]` for a stored run, both adapters in the take-over), `Pulled` (`["pulled", token, payee]`, amount), `Rebound` (`["rebound"]`, floor 3), `Cancelled` (`["cancelled", id]`, by custody and by the account) | `BatchStored` [`d2b2f77e…`](https://stellar.expert/explorer/testnet/tx/d2b2f77e74a748bbde5124ebed5bb1d909e760a11efc65f65dff77d1f843f314); `Ran` and `Pulled` [`216c538a…`](https://stellar.expert/explorer/testnet/tx/216c538acb78859fb858f387986c3d9f9a05654081de40d5f6be7ab408c42c52), [`241013b9…`](https://stellar.expert/explorer/testnet/tx/241013b94fbcc86fb1656506fbc87fb2fe5b1f529d903295f5bda7b6198d8fcb); `Rebound` [`86fa078f…`](https://stellar.expert/explorer/testnet/tx/86fa078fb6cac8a68e7b15514e67b95151044f58ef226e5975223f22fcc43707); `Cancelled` [`f86d15c5…`](https://stellar.expert/explorer/testnet/tx/f86d15c53d53f5ffb997651c4fa33730111d73d4c01ceb6d7ed6a5096be9114f), [`ed023e15…`](https://stellar.expert/explorer/testnet/tx/ed023e15c9ce1add504b02e5dfd234b9d8d782e9b4c950f13c35378212c32799) |

**Not verified on chain.**

- **[UNVERIFIED] a seat re-grant after the 180-day eviction** of the temporary end entry: it cannot be reproduced in real time. The host suite covers it on the real patched wasm (`an_old_end_cannot_revoke_a_regranted_key_after_expiry`). Read-only on the seat above (`CAU2MFRT…`): the end entry (temporary, value 0) and the persistent generation entry (value 1) both live until ledger 8,636,185, which was 3,102,199 ledgers (about 180 days) after the read; the network's `maxEntryTtl` is 3,110,400. The generation guard that fixes it is demonstrated directly above (the old end no longer verifies), and the generation entry is persistent, so it outlives the end entry.

**policy-synth against the chain.** `gatePayees` read the real gate configuration with `payees` on testnet (three payees, the interpreter not among them). `packages/policy-synth/fixtures/rpc/bind.json` remains an offline fixture, not a live recording: its `bind_executor` simulations were edited by hand to the three-argument call (the `__check_auth` hash recomputed). A live recording would run against the pinned interpreter (`CDER6P73…`), which this verification deliberately did not transact against.

**What the testnet runs exercise:** the executor-binding probe deploys its own
interpreter instance from `810f53f1…` and an OpenZeppelin 0.8.0 account
(`8286422f…`, the fixture in `policy-interpreter/tests/fixtures/`). The three
execution scripts deploy fresh gates and adapters from `b01024f3…` and
`4985cd12…` on OpenZeppelin `91a2cd56…` accounts, and install their rules on
the testnet interpreter instance recorded in
`deployments/interpreter-testnet.json`. These logs were recorded on
`CDZV4AG4…`, which runs `69cad1d5…`, this source before the keyless rules;
4.1.0 moved that record to `CD46LN75…` on `810f53f1…`, and since 5.0.0 it names
`CDER6P73…` on `6704996f…`. Their run rule lists the adapter as its
signer, a shape the 0.7.2-line account accepts and the 0.8.0 account refuses
(3017); they test the gate and the adapter. The off-chain suite's live tests
run with `OPB_LIVE=1 bun test` against the same instance.

## Findings from the tools

### 1. `paste` 1.0.15 unmaintained, RUSTSEC-2024-0436 (accepted)

Transitive through `soroban-sdk`. The advisory is in the "no longer
maintained" class and carries no vulnerability rating. It needs an SDK change
to go away; `cargo audit` reports no vulnerability.

### 1b. `crypto-bigint` 0.5.5, RUSTSEC-2026-0387 (accepted, not in the wasm)

Published 23 October 2026: timing variability in operations meant to be
constant-time. The crate reaches this repository only through
`soroban-env-host` (`k256`, `p256`, `elliptic-curve`), which `soroban-sdk`
pulls in for the native test host. `cargo tree --target wasm32v1-none -e
normal` lists no `soroban-env-host`, `k256`, `p256`, `elliptic-curve`,
`crypto-bigint` or `paste` for the interpreter or the adapter, so the deployed
bytes never contain it, and the tests run no secret-dependent arithmetic. The
fix is `crypto-bigint` 0.7.6, which `elliptic-curve` 0.13 cannot take; there is
no fixed 0.5.x, and `soroban-sdk` 27 and 28 both lock 0.5.5. The ignore, with
this reason, is in `contracts/stellar/policy-interpreter/.cargo/audit.toml`,
where CI's `cargo audit` runs; lift it once `soroban-sdk` moves.

### 2. `bun audit`: no vulnerability (resolved)

The earlier lock had seven advisories: four in `@modelcontextprotocol/sdk`
1.31.0, a direct dependency of the MCP server (GHSA-22jm-h49p-29qw,
GHSA-46jr-4wx8-v453, GHSA-6prh-2h8m-c8cw, GHSA-rvq5-wwqv-78pq), two in
`follow-redirects` 1.16.0 through `@stellar/stellar-sdk` (GHSA-q3jh-wrc6-jgq8,
GHSA-8r9p-f939-6h3c) and one in `hono` 4.13.9 through the MCP SDK
(GHSA-5r4p-p66f-jhc7). The lockfile now holds the MCP SDK at 1.32.1, and the
root `overrides` in `package.json` hold `follow-redirects` at 1.16.1 or later
and `hono` at 4.13.11 or later (locked 4.13.13).

The new versions alone fix five of the seven: GHSA-22jm-h49p-29qw,
GHSA-6prh-2h8m-c8cw, the two in `follow-redirects` and the one in `hono`.
GHSA-46jr-4wx8-v453, one large `tools/call` that exhausts the server's memory
during validation, is fixed by the new version together with its opt-in
`maxToolInputElements`, which the server sets to 10,000
(`policy-builder-mcp/src/server.ts`). Without the option, one 1 MiB call
raised the HTTP server's memory by about 480 MB and drew a 26 MB error; with
it the call is refused before validation, peak memory stays near 111 MB and the
error is 230 bytes. `policy-builder-mcp/test/http.test.ts` checks the refusal.
GHSA-rvq5-wwqv-78pq concerns bearer authentication (`expectedResource`), and
the server has none, so it does not apply; a bearer token added later (S-11)
must set it.

`bun audit` finds no vulnerability, and CI runs it on every pull request. It
matches by version range only; the test above is what checks the option.
Threat model row T-27.

### 3. Scout and clippy

**Clippy pedantic and nursery** (`clippy-pedantic.log`, this tree): style
warnings only. Every cast, panic, unwrap, indexing or overflow lint sits in
test code; the contract source has none.

**Scout** (`scout-audit.log`, 27 August 2026, commit `5bae0a8`; its line
numbers are that commit's). The nine medium findings, each reviewed with no
change:

- *Unbounded operations* x3: the walks are bounded by the instance's byte cap,
  depth, leaf and `in`-operand limits, fixed at deployment.
- *Dynamic types in persistent storage* x2: the master signer set is a
  `Vec<Signer>` because it mirrors OpenZeppelin's rule shape, capped at 16.
- *Vec or Map parameters without validating their contents* x2: both are
  validated. `enforce` checks the authenticated set (empty only for a keyless
  bound rule) and re-hashes the rule's signer set against the stored hash;
  `rotate_master_signer_set` checks the new set as `install` does.
- *Storage operation without access control* x1: the line is a `push_back` on a
  local vector inside `literal_to_val`. `dsl.rs` makes no storage call, so the
  lint matched an in-memory push. The contract's storage writes sit behind
  `require_auth` or `require_master` on every path.
- *Unsafe Map access* x1: `map.get(field)` returns an `Option`; the panicking
  variant is `get_unchecked`, which the code does not use. An absent field
  resolves to "no value" and the call does not trap.

On this tree, `cargo scout-audit` 0.3.16 with the command below stopped while
building its detector helper (`scout-driver`, `cargo +nightly-2025-08-07 build`)
on our build host; running it again is a follow-up.

### 4. Entry points against the Stellar Security Portal corpus

Pulled from the portal's open API on 4 August 2026: 832 findings, 150 critical
or high, most of them in the access-control class. The interpreter's entry
points against that class:

| Entry point | Control |
| --- | --- |
| `install` | `smart_account.require_auth()` on every install, the first included, so a rule id cannot be pre-seeded; on a re-install also `require_master`, the same admin set and the next `install_nonce` |
| `bind_executor` | the account's authorisation and `require_master`; a rule scoped to the executor must pin `call_fn == run` or an immediate batch (221) |
| `enforce` | `smart_account.require_auth()`; an empty authenticated set only for a keyless bound rule with one policy (210); the bound executor's authorisation of the exact context; the stored signer hash must equal the live one (204) |
| `uninstall` | `require_master` |
| `rotate_master_signer_set` | the account's authorisation and `require_master` on the current set |
| `check` | always fails, so nothing it reads or calls persists |
| `limits`, `grammar_version` | read only |

`require_master` refuses an empty set, so zero `require_auth` calls never count
as satisfied: the corpus's "authorisation that silently does nothing" class.
The nonce covers its replay class.

### 5. The OpenZeppelin policies the builder pins

`simple_threshold`, `weighted_threshold` and `spending_limit` are OpenZeppelin
example contracts that we built and deployed ourselves: on testnet from
`OpenZeppelin/stellar-contracts` tag `v0.8.0` (`ddc327e`, deployed 26 October
2026), on mainnet from tag `v0.7.2` (`a9c4216`, 9 June 2026). We did not audit
them. Addresses, wasm hashes, the build command and the superseded testnet
`v0.7.2` instances are in `deployments/oz-policies.json`; the addresses are
`SPENDING_LIMIT`, `OZ_THRESHOLD` and `SUPERSEDED_OZ_POLICIES` in
`packages/policy-synth/src/config.ts`.

- From `v0.7.2` to `v0.8.0` the code of `policies/` changes in `spending_limit`
  only: a transfer of amount 0 is always permitted (before, it was refused once
  a lowered limit sat below the total already spent), and the history cap drops
  from 1,000 to 815 entries (the most one ledger entry holds).
  `simple_threshold` and `weighted_threshold` change in comments only, and the
  `Policy` trait is identical, so the `v0.8.0` policies also serve 0.7.2-line
  accounts. Every wasm hash differs because the workspace moved from
  soroban-sdk 26.1.0 to 28.0.0.
- `v0.8.0` ships an upstream diff audit (`audits/Stellar Contracts Library
  v0.8.0 Audit.pdf`, snapshots `fbfde38` to `a5bd8cb`) whose scope names
  `policies/spending_limit.rs` and `smart_account/mod.rs` and `storage.rs`.
  We did not review it further.
- For the mainnet `v0.7.2` builds: `policies/spending_limit.rs` is byte-identical between `v0.7.0` and `v0.7.2`,
  and `v0.7.0` is the newest audit in the upstream `audits/` directory, whose
  scope names the file.
- Two findings of that audit touch this path, and both fixes are in what we
  deployed: L-06 (a negative amount) by the `amount < 0` refusal in `enforce`,
  and H-01 (rule selection changed after signing) by `do_check_auth` adding
  `context_rule_ids` to the signed preimage.
- Upstream ships them "as is". Deploying them beside the interpreter inherits
  that risk.

**Composition:** OpenZeppelin runs every policy on a rule and requires all of
them, so a refusal by any one is decisive. A rule with no policy needs every
signer; a rule with any policy leaves the signer count to its policies, so one
signer can act alone unless a threshold policy counts them.
`oz-threshold-live.log` shows `simple_threshold(2)` refusing one signer (3202)
and permitting two, and `install_policy` refusing a weighted threshold that one
signer meets alone. `simple_threshold` checks the threshold against the signer count at
install only; the interpreter's stored signer hash refuses every call once the
signers change (204), so a signer added behind the threshold breaks the rule
instead of lowering the bar.

## Reproducing the Scout run

`cargo-scout-audit` 0.3.16 cannot analyse a `soroban-sdk` 27 crate unpatched,
and reports a build that never compiled as `Analyzed` with 0 findings. Confirm
a compiled artifact exists under `target/dylint/` before quoting any Scout
number.

```sh
rustup target add wasm32v1-none --toolchain nightly-2025-08-07
cargo scout-audit --manifest-path ./Cargo.toml --exclude storage-change-events -- \
  -Ztarget-applies-to-host -Zhost-config \
  --config 'host.rustflags=["-Zcrate-attr=feature(round_char_boundary)"]'
```

`storage-change-events` is excluded because it overflows the rustc stack.
