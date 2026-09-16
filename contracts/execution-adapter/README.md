# Stateless Prime execution adapter

This implementation uses the existing v5 interpreter plus an executor binding.
It does not use the historical `contracts/execution-policy` prototype.

## Deployment and identity

Deploy this WASM with **Prime as the deployer** and salt
`SHA256(UTF8("prime.execution.adapter.v1"))`, with no constructor arguments.
Deployment must carry Prime's authorization. Its address is
`env.deployer().with_address(prime, salt).deployed_address()`.

Every execute call verifies that address relationship. The adapter stores no
configuration, flags, policies, or batch records. A different Prime cannot use
the address to spend residual assets, even if that other account authorizes it.

This is a new ABI and deployment convention. Do not run old prototype deployment
scripts against it. Existing deployed adapters and interpreter instances are
unchanged by this source update.

## Execute

`execute(prime, interpreter, calls, prime_contexts)`

- `Call` has target, function_name, args, executor_authorizations.
- Calls execute in order; a failure reverts the complete transaction.
- Direct Prime call contexts are derived from the calls.
- `prime_contexts` declares only ADDITIONAL nested Prime-authorized operations.
- All request fields, including both authorization lists, are part of the root
  policy projection. Appending an authorization cannot widen an existing policy.
- No calls or executor grants may target Prime, this adapter, or the selected
  interpreter. Contract-creation grants are rejected.
- Limits: 1–8 calls, 16 additional Prime contexts, 32 executor-authorization nodes,
  authorization depth 8, projection depth 16, 2048 shape entries, 256 leaves.
  The existing interpreter may impose a tighter predicate-size limit.

Before asking Prime to authorize the batch, the adapter registers one invoker
authorization for each exact `interpreter.enforce(Prime, Context)` custom-auth
argument tuple. The interpreter requires the bound executor's authorization and
then runs its existing predicate. Soroban consumes matching grants individually
and drops unused grants when the next authorization frame returns. No begin/end
scope storage or interpreter-specific batch engine is added.

Grants constrain exact context values and counts, **not nested authorization-tree
positions**. Explicit adapter calls retain their declared order.

## Wallet funding

Keep the user's allowance to **Prime**, not the adapter:

1. token.transfer_from(spender=Prime, from=wallet, to=adapter, amount)
2. venue operation using adapter funds and Prime as the position owner

Prime authorizes step 1 through a bound token policy. Funds never enter Prime.
A supported venue may accept direct wallet-to-venue funding instead.
Claims and other no-funding actions omit token calls.

The intended funding flow drains temporary adapter balances within the same
transaction. This is enforced by the installed batch template (including linked
amounts and recipients), not by protocol-specific code in this generic adapter.

## Policies and activation

Install the root rule scoped to the adapter with the agent as signer. Child
rules use the adapter signer and existing v5 venue/token predicates. Bind the
root and **every alternative usable child rule** via:

`bind_executor((prime, rule_id), adapter)`

Binding requires both Prime and the stored policy admins. Reinstall preserves
binding; it shares the policy document's TTL and uninstall lifecycle. The stored
document format changes, so deploy a fresh interpreter; do not assume old stored
documents can decode in place.

Install/bind atomically, or bind all child rules before enabling the agent root.
An unbound alternative child can reintroduce the original bypass.

The TypeScript `buildExecutionBatchPolicy` helper is exported from policy-synth's
`/install` entry. It returns `grammarVersion: 5`, encodedPredicate, predicateHash,
and projectedArgs. Its input is the canonical ScVal tuple of all four execute
arguments. Fields are exact by default; explicit linked i128 slot groups allow
bounded equal amounts.

Projection v1 walks vectors/maps in order, hashes the typed container shape into
two signed i128 limbs, and exposes u32/i128/address/symbol leaves. Other scalars
are pinned by their exact XDR digest. Numeric host small/object representations
do not change the shape. Shared binary fixtures verify Rust/TypeScript parity.

The older general install defaults in this branch still target v4 deployment
pins. This change does not silently retarget them: use explicit v5 install data
and the newly deployed/bound interpreter. UI/SDK rollout and deployment are
separate from this branch-only contract update.

## Verification

Run `cargo test --locked --offline` separately in execution-adapter and
policy-interpreter. Use distinct Cargo target directories: their lockfiles pin
different transitive SDK macro versions.

For compiled-WASM integration, build both crates for `wasm32v1-none --release`,
then set `PRIME_ADAPTER_WASM` and `PRIME_INTERPRETER_WASM` to their absolute
paths when running the adapter tests. `PRIME_DEFAULT_BUDGET=1` resets the SDK
default budget for successful adapter executions and prints resource use.

Execution tests use real OZ account WASM and enforcing authorization. Only
installation uses mocked auth; the permissive agent signer models a compromised
agent that can sign arbitrary requests. Token and venue fixtures are local;
these tests do not establish compatibility with every live protocol or current
network resource settings.
