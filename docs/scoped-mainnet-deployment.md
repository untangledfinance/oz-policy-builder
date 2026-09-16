# Scoped execution: mainnet deployment and funding

Status: deployed and verified on PUBLIC at 2026-09-16 08:21:27 UTC. Both pinned WASM hashes are readable, the deterministic interpreter instance matches its pin, and `grammar_version()` returns 6. Three transactions succeeded; actual charged fees totaled **94.8368238 XLM**. The deployer retained **19.1631762 XLM** immediately afterward. See `audit/evidence/scoped-mainnet-deployment.json`.

## Exact deployment identity and artifacts

| Item | Value |
| --- | --- |
| Network | `Public Global Stellar Network ; September 2015` |
| RPC | `https://mainnet.sorobanrpc.com` |
| Existing CLI signing identity | `mainnet_deployer` |
| Public deployment account | `GCIVG2AIEWMDA43HX2HRCYVNY7PH7HMPYVN42LQ5XBSHBLHFUWG47NFN` |
| Interpreter v6 WASM SHA256 | `67bbee0914172e0c6d2cdb4038b986660265f53d7e6443f3da0453656337a15a` |
| Adapter v2 WASM SHA256 | `719240da0e3cf8a7fa32dad3a1af65c01276e4194a8ba68eef7b8a9d27126f7c` |
| Verified interpreter address | `CCZDVEJOVQ2H5NDLDYLF6N47WDC2ZW7UTLY4Z5LCIL3ZMEHUMKNGW747` |
| Salt SHA256 hex | `c722eb5ea61ad80593f5cabdac2989b6c17060841b95b7ddacd0c16c51c741a4` |

Salt text is `prime-policy-interpreter:v6:67bbee0914172e0c6d2cdb4038b986660265f53d7e6443f3da0453656337a15a`. The salt bytes are SHA256 of that UTF-8 text. The address is the Stellar contract-ID preimage hash using PUBLIC, the public deployment account, and this salt. It was independently reproduced using `stellar contract id wasm`. The actual deployment receipt verifies this address, its instance hash, and `grammar_version() == 6`.

The script uploads interpreter and adapter code and deploys one interpreter instance. Per-Prime adapter instances are activated later using the Prime as deployer and salt `prime-execution:v2`; this script does not deploy a generic adapter instance, create an account, fund anyone, install policies, migrate existing rules, or perform venue operations.

## Read-only preflight

Run from the implementation checkout:

```bash
bun scripts/deploy-scoped-mainnet.ts --fee-cap-xlm 112 --instance-budget-xlm 1
```

Default artifact directory is `/home/ubuntu/work/prime-scoped-target/wasm32v1-none/release`; override with `--artifact-dir` only for binaries with exactly the pinned hashes. No network writes or signing happen without `--execute`. Dry-run reports exact missing code, simulated upload fees, reserve-adjusted funds, the expected interpreter address, and whether it exists. It fails if the projected uploads plus reserved instance budget exceed the cap. It cannot simulate exact interpreter creation until its WASM is live.

The successful run used a 112 XLM cumulative declared-fee cap and a 1 XLM interpreter-instance allocation. Fresh upload simulation was 109.0178003 XLM; the bounded upload-plus-instance estimate was 110.0178003 XLM. Simulation budgets exceed actual charged fees because refundable resource fees can be returned.

Tuan's 70 XLM top-up and the authorized consolidation of 25.8509373 XLM from seven controlled deployment/project wallets brought the source to 114 XLM before deployment. Every source retained its required reserve plus its specified fee buffer. See `mainnet-funding-consolidation.md` and its public receipts. The deployment script itself never collects funds.

| Mainnet transaction | Hash | Charged XLM |
| --- | --- | ---: |
| Upload interpreter | `436068448509167d0331500348c11c7aa1bc1045e613bc20203ccb7d4463598d` | 86.3741590 |
| Upload adapter | `c7a33b33229bf239e1714828cd47aee8f8be7a35c349117c04204a0f2cdbed0f` | 8.4237144 |
| Create interpreter v6 | `93391a5443c74f53839669711f80314f693d538ddc03e98a725751d7bb71baf1` | 0.0389504 |

The first upload attempt (`29df981e086ffa599d663df044914f1338654f9ceba21206fa4efca9fc619e13`) expired without inclusion and charged zero. Two RPCs and Horizon showed no transaction, the closed ledger exceeded its conservative time-bound expiry, the source sequence and 114 XLM balance were unchanged, and code remained absent. Its public expiration evidence is preserved. The retry raised the inclusion bid from 100 to 1,000 stroops after observed p99 of 200.

## Fee construction and limits

The installed `@stellar/stellar-sdk` 14.4.0 `rpc.assembleTransaction` adds the RPC resource fee, while its resolved `@stellar/stellar-base` 14.1.0 builder also adds `sorobanData.resourceFee()` in `build()`. Using both yielded double resource fees in unsigned envelopes. The script preserves simulation authorization entries and Soroban data but passes only the 1,000-stroop inclusion fee to `TransactionBuilder`; it asserts the final fee equals exactly `minResourceFee + 1000`. A changed dependency behavior fails closed.

The total cap counts declared transaction fees across the persisted deployment receipt, including inclusion fees. Each transaction is simulated immediately before signing, checked against remaining cap, and the interpreter allocation is retained while uploading. Remaining cap funding above current reserve and selling liabilities is required before starting and before each transaction. The script cannot make multiple ledger transactions atomic: a fee change or failure after a successful upload can leave uploaded code without an instance. It stops rather than exceeding the cap; successful uploads are reused on retry. Resumed runs count all prior successful or included failed declared fees against the same explicit cap. Evidence-backed expired transactions charge zero; unresolved outcomes block further writes. Duplicate receipt hashes are rejected.

## Execute only after review and funding

After root confirms feature/review gates and the public deployment account has sufficient funds:

```bash
bun scripts/deploy-scoped-mainnet.ts \
  --execute \
  --fee-cap-xlm 112 \
  --instance-budget-xlm 1
```

The script checks the CLI identity's public address, artifact hashes, PUBLIC network passphrase, current code/instance entries, and budget before calling `stellar tx sign --sign-with-key mainnet_deployer`. The unsigned XDR is passed through stdin. CLI output is retained only in memory, checked for the expected body and public-key signature, and submitted to the pinned RPC. No private key is read by this script, printed, stored in the repository, or sent to a remote service.

Do not edit hashes or bypass the identity/fee checks to overcome a failure. Archived code requires a separately reviewed restore. Existing interpreter code at the expected address must match the exact hash. Missing uploads are skipped idempotently once present.

## Public receipt and completion checks

Successful execution writes `docs/audit/evidence/scoped-mainnet-deployment.json` (override `--receipt` if needed). It contains public deployment pins, transaction hashes, simulation ledgers, declared and charged fees when available, outcome, and verification time. It contains no private keys, signed XDR, or signatures. A transaction hash is saved before submission so an interrupted broadcast can be investigated. An unresolved prior outcome blocks retry; inspect it through RPC rather than deleting that record. RPC history may expire, in which case reconcile public ledger evidence manually before proceeding.

Completion requires both code hashes readable, the deterministic interpreter instance using the expected interpreter WASM, and read-only `grammar_version()` returning 6. Only then may the app's mainnet manifest be enabled. Follow separately with own-funds Prime activation, policy installation, venue operation, adversarial rejection checks and allowance cleanup; deployment alone does not establish that flow.

For the UI, the existing production procedure in Octopos is `scripts/deploy-web.sh mainnet`; it loads `.env`, runs the mainnet build guard, injects required Vite settings, deploys worker `octopos-web-mainnet`, and smoke-checks public hosts. Its smoke checks are nonfatal, so inspect output. Do not run infrastructure deployment for a UI-only change.
