# One-adapter scoped execution

Tuan authorized implementation after choosing one small new ExecutionAdapter, existing Prime-owned positions and existing policy infrastructure. This supersedes the separate ExecutionPolicy prototype; its deployment and UI remain disabled.

## Architecture
One new contract TYPE: ExecutionAdapter. Existing PolicyInterpreter gains an execution-document envelope and authenticated begin/end lifecycle. This requires a NEW interpreter version/instance (grammar 6); grammar-5 deployments remain unchanged. Thus one new contract type does NOT mean only one WASM upload for release. No OZ account changes, no factory, no new policy contract type, no position or allowance topology change.

Adapter constructor immutably binds Prime and interpreter. execute(prime,calls):
1. Check binding, 1..8 calls.
2. interpreter.begin_execution(adapter,prime,calls), authenticated by the adapter's immediate invoker authorization.
3. prime.require_auth() over the entire execute arguments.
4. Execute each call and its exact executor authorization entries.
5. interpreter.end_execution(adapter), removing the ENTIRE scope, including unused contexts.
Errors propagate: the host rolls back scope creation, allowances, movements and venue changes. Never catch an execution error and commit a partial batch.

Scope is ordinary ledger-backed storage, NOT transient storage. Its lifetime is limited by explicit end removal and rollback. A trusted immutable adapter always pairs begin/end. Re-entry into an existing scope denies. A configured adapter must have verified code AND constructor bindings. Owner may use its default rule; agent uses scoped interpreter documents. Existing independently authorized agent rules remain independent capabilities and must be explicitly retired to claim account-wide batch-only behavior.

## Interpreter document
Existing PolicyInstallParams and owner/admin/signers/nonce/hash controls are preserved. Grammar 6 adds predicate envelope [execution_v1, {executor, plans}].
Each plan specifies an EXACT ordered vector of steps. Each step has an existing DSL call predicate and an exact recursive vector of authorization predicates. Empty vector means no executor auth permitted. Contract creation auth is denied. All nodes, nesting and bytes have caps.
Generic equality links select values by bounded Index/Key paths through the full calls value. Missing paths deny. Supply template links custody pull amount = venue amount = executor transfer amount. This avoids protocol branches in either contract; template builders supply ordinary predicates and structural constraints.
Reserved interpreter/account/adapter administrative targets cannot be called or authorized by execution documents.

Root execution enforcement validates the actual scope's complete call vector, exact order, all auth nodes and equality links, then marks the document hash + operator-set hash as approved. Child account contexts require that same approved document/operator set and consume an exact matching top-level call slot. Rules for token/pool/fixture have identical documents but independent IDs. No active scope or unapproved document => deny. Successful cleanup removes even slots which never required account authorization.

## Limits and implications
This is a new interpreter instance, not a silent upgrade. Existing rules aren't migrated automatically. Deterministic adapter salt changes to prime-execution:v2 because its constructor/lifecycle differ from the spike; network manifest pins interpreter + adapter hashes. Mainnet remains disabled until independent verification.
Batch-only is about these new execution rules; other live rules can independently authorize operations. Atomicity doesn't prove economic safety of an arbitrary venue. Unknown venues need correctly authored predicates; no universal economic guarantees are claimed.

## Verification
Native tests cover scope absence/cleanup, forged lifecycle calls, complete plan validation, order, repeated calls, nested auth, equality links, missing selectors and error rollback. Full interpreter regression suite protects existing rules.
Fresh disposable testnet account + actual OZ WASM/auth: Blend supply/withdraw, no-funding, wrong recipients/amounts/auth trees, standalone actions before/after successful/failed batches, unused-context cleanup and late ledger failure. Keep real receipts separate from simulation denials.
Prime independently reviews code and reproduces tests before integration/mainnet verification with bounded own funds.
