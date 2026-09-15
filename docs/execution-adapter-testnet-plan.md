# Generic execution adapter — testnet verification

Status: isolated experimental work, not production/audit approval.

Goal: verify generic Soroban batches with actual OZ authorization, custody allowances, real Blend testnet supply, no-funding calls, policy denials, and on-ledger rollback.

Design from the conversation: ordered Call { target, function_name, args, executor_authorizations }; execute(prime,calls) binds the entire plan to Prime auth and propagates all failures. No protocol templates or protocol-specific executor deployment. A prototype batch policy evaluates each actual call and every nested executor authorization using the existing predicate evaluator. It is separate from the existing grammar interpreter and remains experimental.

Security hypothesis to test: accepting an arbitrary Prime on a shared executor lets another Prime spend leftover executor tokens. Reproduce this before fixing. Minimal candidate fix: an immutable per-instance Prime binding, checked before require_auth; same WASM for every account and protocol.

Tasks
- [x] Add local tests for ordered execution, no-funding action, late failure rollback, unauthorized authority substitution, and whole-plan policy validation. Run against incomplete implementation and record failures.
- [x] Implement contracts/execution-adapter (generic executor), contracts/execution-policy (experimental OZ batch policy reusing DSL evaluator), contracts/execution-test-venue (explicit test fixture with state change/failure).
- [x] Build WASMs with soroban-sdk 27.0.2 and native tests. Test policy rejects modified target, token destination, amount, extra call, authorization tree, and policy replacement.
- [x] Add scripts/execution-adapter-testnet.ts. Fresh faucet-funded custody/agent/stranger keys; persist keys only in chmod-600 external temporary file, never logs/git. Guard network to TESTNET. Deploy adapter/policy/test venue and real OZ WASM; install agent mandates and finite XLM allowance to Prime.
- [x] Submit actual Blend supply (custody -> executor -> Blend), withdrawal to custody, no-funding fixture action, human-signed higher-limit execution, allowance revoke. Verify balances/positions and auth contexts.
- [x] For late venue failure, prepare a successful transaction then change only fixture state so the identical signed batch fails on ledger; verify custody/allowance/executor/Prime/fixture unchanged by failed batch. Fees excluded from rollback invariant by using agent as source.
- [x] Persist public addresses, transaction hashes, receipts, observations, source versions, and limitations. Review diff and commit isolated branch without merging/deploying mainnet.

Required limitations: this is not a production audit; prototype batch policy validates call/auth allowlists but not arbitrary economic correctness; amount limits are per call, global budgets use finite allowance; real-wallet MetaMask/Freighter UI is not covered; explicit fixture results are not claimed as live venue claim/pause integration.
