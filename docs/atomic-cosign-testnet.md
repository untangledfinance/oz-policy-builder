# Atomic SDK and co-sign continuation: live TESTNET proof

Run date: 2026-09-16. Public evidence: [`atomic-cosign-testnet.json`](./atomic-cosign-testnet.json). Reproduction script: [`verify-atomic-cosign-testnet.ts`](../scripts/verify-atomic-cosign-testnet.ts).

The shipped SDK discovered custody, asset, Blend pool, adapter, interpreter, rule IDs, amount cap and the mandatory 2-of-2 operator policy from the disposable agent key and Prime address. Network/RPC and app origin are infrastructure configuration. No wallet, token, pool, executor or rule ID was supplied to `connectExecutionLane`.

- Prime: `CDVRPL7IKPKPI5YNAUEEJGM4OQSGRJIQF4VCPUIZCCUPGVRWNOM5XQ2Q`
- Adapter: `CAKGAHA5FUWTQVQDJ4LDPAYUTDXQ3GG2BWY3ADX5GO3NENK5S4YDJMQ5`
- Canonical rule IDs: root 6, token child 4, pool child 5.
- Root combines the pinned grammar-v5 interpreter with the pinned OZ `simple_threshold(2)` policy. Merely listing two keys does not establish 2-of-2.
- Both children require the adapter contract signer and explicit stored executor binding. The root and children use the exact SDK `statelessBlendPolicies` output.

## Results

| Check | Evidence |
| --- | --- |
| Discovery uses agent key + Prime | Complete live lane and 2-of-2 threshold recorded |
| `supply(1000000n)` returns `needs_signatures` | Self-contained app URL; agent signed, only human cosigner missing |
| Link creation does not broadcast | Source sequence, wallet balance, allowance and position unchanged |
| First approval is portable and cryptographically valid | Production app verifies 3 explicit G-address auth entries, one for each Prime context; 4 auth entries including Prime |
| One approval cannot execute | Enforcing RPC simulation rejects missing cosigner authorization |
| SDK amount at exclusive cap is refused | `supply(2000000n)` throws rather than returning another link |
| Fully approved amount at cap is refused on chain | 6 genuine G signatures; enforcing simulation fails interpreter `ArgMismatch #100`; state unchanged |
| Wrong network / expiry / claimed signatures | Actual production load and continuation reject before signer callbacks |
| One flipped Ed25519 signature byte | Actual production load and continuation reject invalid prior cryptographic approval before callbacks |
| Second approval completes real Blend supply | App appends 3 cosigner signatures, signs one envelope and broadcasts successfully |
| Cleanup | Owner withdraws all supply and revokes remaining allowance; shares, Prime balance, adapter balance and both allowances are zero |

Successful atomic supply: `d886862269eb6af435b1878debda1865d6c2350f2ef55443e0f339ea22ca44e2`. The wallet and allowance each decreased by exactly 1,000,000 base units (0.1 XLM), and supply shares increased from 0 to 490,849. RPC receipt was separately read back as `SUCCESS`.

Owner withdrawal: `556fbc6469000596dd326e199eddb7026dc67d0ac98a5c9429d2aeb3abd861d9`. Final allowance revocation after the separate cap test: `2943445d5d78d0a08f11aab99970739b81d6e750600eb89d85c3a3aed7f9212a`.

## Scope and reproduction

This used the actual production app `loadCosignRequest`, `verifyExecutionCosign` and `continueCosign` modules with `VITE_STELLAR_NETWORK=testnet`, fresh chain reads and a disposable local `PrimeSigner`. It proves the SDK-to-app continuation and network execution path. It is **not a browser wallet interaction proof**. No mainnet writes occurred.

The first disposable fixture was correctly refused because its child predicates omitted the canonical explicit `call_contract` equality. The fixture root was removed first, then children were replaced with the shipped exact template and rebound before the replacement root was installed. The discovery matcher was not relaxed. Those setup replacement transactions remain in the evidence.

Source checkouts at verification: core `fa78c74d6548fd64af1de740d98cccaed4260c95`, SDK `524baf278ff27db92287064ca59434743484055b`, app `bf307d74e9cc620c06bcf65ed73e94c7e3972edc`. The proof script is committed separately after these sources.

Use a new private state path for every independent reproduction. The script generates three fresh keys, writes them only to a mode-0600 local state file, and funds them with TESTNET Friendbot. Never commit or print this state file. The public evidence file contains addresses and outcomes only; half-signed payloads remain in private state.

```sh
export PRIME_STATE=/private/path/fresh-atomic-testnet.json
export PRIME_SDK_ROOT=/path/to/prime-ts-sdk
export PRIME_APP_ROOT=/path/to/octopos
bun scripts/verify-atomic-cosign-testnet.ts
VITE_STELLAR_NETWORK=testnet PRIME_PROOF_PHASE=prove bun scripts/verify-atomic-cosign-testnet.ts
PRIME_PROOF_PHASE=cap-negative bun scripts/verify-atomic-cosign-testnet.ts
PRIME_PROOF_PHASE=verify bun scripts/verify-atomic-cosign-testnet.ts
```

`prove` withdraws and revokes after success; `cap-negative` revokes in `finally`. If an interrupted run leaves a position or allowance, `PRIME_PROOF_PHASE=cleanup` closes it using only that disposable fixture owner. The consumed/expired proof link is not intended as a reusable signing request; new SDK calls create fresh requests.
