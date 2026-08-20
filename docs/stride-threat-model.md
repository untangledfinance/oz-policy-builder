# OZ Policy Builder - STRIDE Threat Model

**Subject:** `policy-interpreter` Soroban contract plus the `@crediolabs/policy-synth`, `@crediolabs/policy-builder-cli`, `@crediolabs/policy-builder-mcp` off-chain toolchain.
**Date:** 2026-08-20
**Methodology:** Stellar STRIDE Threat Modeling, "STRIDE Threat Model Template" and "Threat Modeling How-To Guide" pages at `developers.stellar.org/docs/build/security-docs/threat-modeling`. The Stellar template's four-question scaffold (What are we working on / What can go wrong / What are we going to do about it / Did we do a good job) and its STRIDE-per-element format are followed.
**Repo:** `untangledfinance/oz-policy-builder`
**Grammar version:** 2 (`SELF_VERSION`, `src/version.rs`)
**Subject tree:** the reduced contract described below - 1,225 nSLOC of on-chain production code, down 49.4% from 2,422.

---

## 1. Scope and version

### In scope

- `contracts/policy-interpreter/` - the on-chain Soroban contract that evaluates one predicate per `enforce` call.
- `packages/policy-synth/` - the off-chain core: IR, predicate encoder/decoder, mandate and recording synthesis, install/revoke/info wrappers, registry, schemas.
- `packages/policy-builder-cli/` - the CLI front-end over the synth core.
- `packages/policy-builder-mcp/` - the MCP server (stdio and Streamable HTTP transports) and its tool registrations.

### Out of scope, named with their trust assumption

- `contracts/test-blend-pool/` - a test double. Trust assumption: NOT production code; testnet only. Not modelled.
- OpenZeppelin Stellar smart-account contracts. Trust assumption: OZ smart-account correctness is assumed - the interpreter is a delegate of one. OZ's `__check_auth`, `add_context_rule`, `remove_context_rule` and signer-threshold semantics are external dependencies.
- Stellar protocol, validators, RPC endpoints. Trust assumption: Stellar validators and pinned RPCs behave correctly; the install/revoke/info paths bind their signatures to whichever RPC answered.

### What changed in this revision, and why the model is shorter

This revision models a deliberately reduced contract. Four capabilities were
removed outright: the oracle price path, the `valid_until` leaf, the
`call_arg_scaled` slippage floor, and `invocation_count` rate limiting.

The security consequence is not cosmetic. **`enforce` is now stateless**: it
reads no mutable state and writes none. Every predicate leaf is answered from
the authorized call itself. That deletes, rather than mitigates, four whole
threat classes that the previous model had to carry:

- external-feed trust (spoofed prices, fingerprint drift, feed outage, the
  single-operator residual between two feeds published by one party);
- counter integrity (a counter archiving before its document and silently
  refilling a cap; a window counted twice; the per-transaction write-entry cap);
- a master-gated circuit breaker, and the account-vs-rule scoping question it
  raised;
- two install-time validation gates whose only job was to stop a removed leaf
  from failing unsafely at evaluation.

Two residual risks from the previous revision (oracle single-operator; oracle
pause scoping) are therefore **retired, not accepted** - the code they described
no longer exists.

### Methodology followed

The Stellar STRIDE Threat Model Template prescribes a four-question scaffold plus a STRIDE table per data flow. The How-To Guide adds: enumerate external entities, processes, data flows, data storage, trust boundaries; apply STRIDE per subprocess. Sections 2-8 follow that structure.

---

## 2. System decomposition

### Components

| ID | Component | Boundary | Purpose |
|---|---|---|---|
| C1 | `policy-interpreter` Soroban contract | on-chain | Stores `(predicate_bytes, signers_hash, master_set, nonce)` per rule; evaluates on `enforce`; gatekeeps install, uninstall, rotate. |
| C2 | OpenZeppelin smart-account contract | on-chain (out of scope but on the call path) | Calls `interpreter.install` / `enforce` / `uninstall` on the user's behalf; produces signed auth trees. |
| C3 | `policy-synth` core | off-chain (TypeScript) | Synthesises a `ProposedPolicy` from a `MandateSpec` or `RecordedTransaction`; emits canonical ScVal predicate bytes + hash. |
| C4 | `policy-builder-mcp` server | off-chain (TypeScript) | Exposes the policy tools over stdio or Streamable HTTP. |
| C5 | `policy-builder-cli` | off-chain (TypeScript) | Thin command-line surface over the synth core. No key custody. |
| C6 | Wallet | user-side | Signs the unsigned XDR the MCP/CLI returns. The wallet signature is the user-confirmation step. |
| C7 | Pinned Soroban RPC | external network | Provides `getAccount`, `simulateTransaction`, `getLatestLedger`, `getTransaction`. URL is pinned per network. |

### Data storage

Four persistent entries per rule, all written at install, all sharing one
lifecycle. There is no entry that `enforce` writes.

| ID | Storage | Lifetime | Who writes | Notes |
|---|---|---|---|---|
| S1 | `(account, rule_id, K_DOC=1)` -> `StoredDoc { predicate_bytes, predicate_hash }` | persistent; TTL bumped on the permit path | `install` | `src/storage.rs` |
| S2 | `(account, rule_id, K_NONCE=2)` -> `u32` | persistent; bumped alongside K_DOC | `install` | replay protection |
| S3 | `(account, rule_id, K_SIGNERS_HASH=3)` -> `BytesN<32>` | persistent; bumped alongside K_DOC | `install`, `rotate_master_signer_set` | binds the policy to a signer set |
| S4 | `(account, rule_id, K_MASTER_SET=4)` -> `Vec<Signer>` | persistent; bumped alongside K_DOC | `install`, `rotate_master_signer_set` | governs install/uninstall/rotate |

TTL: `TTL_BUMP_THRESHOLD` 100, `TTL_BUMP_TO` 518,400 (`src/storage.rs`). All
four are extended together in `state::extend_state_ttl`, guarded on
`p.has(&key)` so the bump never creates state.

### External dependencies (named, with trust assumption)

- **Stellar validators + RPC** - assumed honest at the protocol level; install/revoke signature digests bind to whichever RPC answered. RPC URLs are pinned per network in `packages/policy-synth/src/run/schemas.ts`.
- **OpenZeppelin smart-account contracts** - assumed correct. The interpreter reads `Context::Contract` from OZ's `__check_auth` invocation tree (`src/state.rs`); OZ routes `enforce` calls into the interpreter.
- **Soroban host** - assumed correct; the interpreter calls `crypto().sha256`, `storage().persistent().set/get/has/remove/extend_ttl`, `ledger().timestamp/sequence`.

There is **no external data feed** in this revision. The contract makes no
cross-contract calls during `enforce`.

### Actors

| Actor | Trust | Capability |
|---|---|---|
| Principal / account owner | trusted by self, untrusted by the interpreter | Holds the source wallet key; signs the install/revoke XDR; picks the signer set. |
| Agent key holder (the policed signer) | trusted by the policy author; treated by the contract as one of `authenticated_signers` on every enforced call | Holds a single `Signer::Delegated` key; the contract's policy bounds what that key may call. |
| Operator / deployer | trusted at deploy time | Deploys the interpreter wasm; pins the RPC URLs and the interpreter address; ships the synth core and the MCP server. |
| Auditor | untrusted; writes the audit | Reads the source and the test evidence. |
| Attacker classes | untrusted by definition | (a) Remote attacker probing the MCP HTTP server. (b) Local user-space attacker who can post to `127.0.0.1:PORT/mcp`. (c) Compromised LLM agent issuing malicious tool calls. (d) Policy author who mis-specifies the policy - not adversarial, but their mistakes are an elevation-of-privilege vector. (e) Adversary who submits a hand-crafted predicate bypassing the synth. |

### Design stance - the asymmetry the threat model must reflect

- **One immutable, audited, versioned predicate interpreter; policy is DATA.** A bad policy is a user error (a known-acceptable risk); a bad interpreter is a systemic failure. The interpreter is the audit-once surface; policy bytes are untrusted data validated fail-closed at install and re-validated at every `enforce`.
- **Wallet signature is the user-confirmation step.** The MCP server holds no key material; `install_policy` returns an unsigned XDR. The server is stateless, so there is no two-call handshake.
- **v1 scope is one authorised call.** `extract_call` handles `Context::Contract` only and panics `MissingState` on any other context shape.
- **Stateless enforcement is a security property, not just a size reduction.** The contract cannot be attacked through state it does not keep.

---

## 3. Assets

What an attacker wants:

1. **Account balances reachable by the policed signer.** The interpreter authorises one call at a time; the reachable surface is whatever the smart account's balances and allowances make available to that signer.
2. **Integrity of the installed predicate.** A predicate that "looks like" the author's intent but permits more. Mitigated by `sha256(predicate_bytes)` matching the caller-supplied `predicate_hash` at install.
3. **Interpreter immutability.** A future interpreter at a different address cannot authorise against the pinned interpreter; install is refused unless `allowUnpinnedInterpreter: true`.
4. **Availability of `enforce`.** A DoS on `enforce` bricks the policed account - it falls through to OZ's no-policy rule, which requires all-of-N signers (see Verified Constraints). The interpreter fails CLOSED on every deny code; `panic_with_error!` rolls back the frame.
5. **Master-set authority.** Whoever passes `require_master` can install, uninstall and rotate. The set is established at install and rotated only by itself.
6. **Cross-layer integrity: TS encoder vs Rust decoder.** If they diverge, a TS-encoded policy could install cleanly and evaluate differently than the synth's self-verify predicted. The conformance suite is the structural witness.

### Verified constraints the model must respect

- **OZ no-policy rule vs POLICED rule.** On an OpenZeppelin smart account, a no-policy context rule requires the FULL signer set (all-of-N); attaching a POLICED rule lets any ONE signer act alone (any-of-N). The review card surfaces this via `signerNote` whenever `signers.length >= 2`. Adding a second signer "for two approvals" produces the opposite of the intent.
- **Fail-closed on every deny.** `panic_with_error!` rolls back the entire frame; the host emits `Error(Contract, N)`.
- **TTL bump only on the allow path.** `extend_state_ttl` runs before `evaluate`; a deny panics and the host rolls back. The bump is gated on `p.has(&key)` so it never creates state.
- **Install-time shape validation.** Every "would silently fail at enforce" shape is refused at install: grammar-version mismatch (200), oversized predicate (207), hash mismatch (208), undecodable predicate (201), empty signer set (209), more than `MAX_SIGNERS` 16 signers (217), an `External` signer in the master set (212), and a predicate carrying no selector leaf (216).
- **Grammar-version parity across layers.** The off-chain builder emits `grammar_version` equal to the contract's `SELF_VERSION`. A mismatch is refused at install; this was a live defect found in this round (see Section 8).

---

## 4. Trust boundaries and data flow diagram

```mermaid
flowchart TB
    U[/Principal - wallet + key holder/]
    AG[/Agent key holder - policed signer/]
    ST[/Stellar validators + pinned RPC/]
    OZ[/OZ smart-account contract/]
    W[/Wallet - sign only/]

    subgraph MCP["Off-chain - MCP server process"]
        direction TB
        subgraph PINS["Pinned constants"]
            IP["interpreter pin + RPC pin"]
        end
        TOOLS["policy tools: record / synthesize / simulate / verify / install / merge / revoke / get_info"]
    end

    subgraph SYNTH["Off-chain - policy-synth core"]
        direction TB
        REG["known-addresses registry"]
        ENC["encodePredicate + caps + validateLeafValues"]
        ADP["IR -> interpreter adapter"]
        AD2["IR -> OZ built-in adapter"]
        SIM["simulate + verify harness"]
    end

    subgraph ONCH["On-chain - Soroban"]
        direction TB
        PI["policy-interpreter wasm - immutable, pinned, stateless at enforce"]
    end

    U -->|"policy intent (MandateSpec)"| TOOLS
    U -->|"tx hash / XDR"| TOOLS
    TOOLS -->|"Validated input"| SYNTH
    SYNTH -->|"encodedPredicate + hash"| TOOLS
    TOOLS -->|"unsigned add_context_rule XDR"| W
    W -->|"signed XDR"| ST
    ST -->|"InvokeHostFunction"| OZ
    OZ -->|"delegated call: install / enforce / uninstall / rotate"| PI
    PI -->|"emit Error(Contract, N)"| ST
    ST -->|"auth nonce + rootInvocation"| TOOLS
    TOOLS -->|"describes (decoded from XDR)"| U
    AG -->|"authenticated_signer"| OZ
    OZ -->|"Context::Contract"| PI

    subgraph TB1["TB-1: Principal <-> MCP server"]
        U -.-> TOOLS
    end
    subgraph TB2["TB-2: MCP server <-> Pinned RPC"]
        TOOLS -.-> ST
    end
    subgraph TB3["TB-3: MCP server <-> policy-synth core"]
        TOOLS -.-> SYNTH
    end
    subgraph TB4["TB-4: Wallet <-> Stellar validators"]
        W -.-> ST
    end
    subgraph TB5["TB-5: OZ smart-account <-> policy-interpreter"]
        OZ -.-> PI
    end
    subgraph TB6["TB-6: Agent key <-> OZ smart-account"]
        AG -.-> OZ
    end
    subgraph TB7["TB-7: MCP server <-> Known-addresses registry"]
        TOOLS -.-> REG
    end
    subgraph TB8["TB-8: User-supplied predicate bytes <-> contract"]
        U -.-> PI
    end
```

### Trust boundaries (numbered)

| ID | Boundary | Crossing | Trust direction |
|---|---|---|---|
| TB-1 | Principal to MCP server | JSON-RPC over stdio or HTTP | untrusted -> server (loopback-only by default) |
| TB-2 | MCP server to pinned RPC | HTTPS | server -> pinned RPC (pinned; opt-in to override) |
| TB-3 | MCP server to policy-synth core | in-process function call | same process; one trust domain |
| TB-4 | Wallet to Stellar validators | signed transaction envelope over HTTPS | user-controlled -> validators |
| TB-5 | OZ smart-account to policy-interpreter | cross-contract call (soroban-sdk 27) | OZ auth tree binds -> interpreter evaluates |
| TB-6 | Agent key to OZ smart-account | signed auth entry per call | agent -> OZ (`authenticated_signers`; OZ fails the call if no signer authorises) |
| TB-7 | MCP server to known-addresses registry | in-process lookup | read-only; addresses are pinned constants |
| TB-8 | User-supplied predicate bytes to interpreter | `install` payload ScVal bytes | untrusted -> interpreter (fail-closed at install + re-validated every `enforce`) |

Two boundaries from the previous revision (interpreter to oracle primary,
interpreter to oracle secondary) no longer exist: the contract makes no
cross-contract calls during evaluation.

---

## 5. STRIDE analysis per element

For every element, all six categories are addressed. "Not applicable" rows are kept explicit.

### Element C1 - `policy-interpreter` contract

| ID | Cat | Threat | Attack scenario | Likelihood | Impact | Mitigation | Residual |
|---|---|---|---|---|---|---|---|
| C1-S.1 | Spoofing | Attacker submits `enforce` as if it were the smart account | Anyone could drive the policy's evaluation path against an account they do not control | Low | High | `smart_account.require_auth()` is the first statement in `enforce` (`src/lib.rs`). | The require_auth is the host's guarantee; if the OZ smart-account contract is broken the bound moves. |
| C1-S.2 | Spoofing | `authenticated_signers` payload forged to claim authority | Attacker prepends a master signer to bypass a non-master check | Low | High | `authenticated_signers.is_empty()` panics (210); `require_master` calls `require_auth` on every stored master signer (`src/auth.rs`), and OZ enforces the signature map separately. | None beyond the host. |
| C1-T.1 | Tampering | Predicate bytes mutated between hash-check and store | A same-shape-but-different-bytes payload installed under a stale hash | Low | High | `sha256(predicate_bytes)` recomputed and compared against `predicate_hash`; mismatch panics 208. | None. |
| C1-T.2 | Tampering | Rule's live signer set changes behind the policy's back | A different signer set silently authorises a permit the policy was written against a stricter set | Medium | High | At every `enforce`, the live signer set's sha256 is compared against the value stored at install; mismatch panics 204. `rotate_master_signer_set` is the authorised mutation and updates both `signers_hash` and `master_set` together. | None - rotation is the only path. |
| C1-T.3 | Tampering | Non-master signer attempts to install or rotate | Any signer could overwrite the predicate | Medium | Critical | `require_master` calls `require_auth` on every member of the stored master set. Install additionally requires `smart_account.require_auth()` on **every** install, so an attacker cannot pre-seed a fresh `rule_id` with their own master set. | None. |
| C1-T.4 | Tampering | Master set rotation to an empty or External set bricks the rule | `Signer::External(_, _)` verifier contracts never satisfy `require_auth`; an empty set iterates zero times | Medium | Medium | `rotate_master_signer_set` refuses an empty set (209), an oversized set (217), and any External set (212). The same refusals apply at install. | None - the refusal is symmetric. |
| C1-R.1 | Repudiation | Action denied without a specific reason code | Off-chain tooling cannot distinguish "not on the allowlist" from "argument mismatch" | Low | Low | Every deny goes through `panic_deny_reason` with an exhaustive `From<DenyReason> for PolicyError` map; the contract emits `Error(Contract, N)`. Distinct reasons: `ArgMismatch` 100, `ContractScope` 101, `ArithmeticOverflow` 102, `UnsupportedNode` 103, `StatefulBound` 104, `NotInAllowlist` 105. | None within the interpreter. |
| C1-R.2 | Repudiation | Permit without an audit trail | An operator cannot tell which signer authorised a given permit | Medium | Low | `authenticated_signers` is passed into `enforce` from OZ and not stored; OZ is the source of truth for auth records. | The interpreter cannot authoritatively record the signer set; OZ's `__check_auth` is the audit path. |
| C1-I.1 | Info disclosure | Predicate bytes leak the policy shape | The predicate is stored as raw bytes; the ledger is public | Low | Low | All storage is `persistent()` and addressable by `(account, rule_id, K_DOC)`. | The interpreter does not encrypt the predicate; secrecy is the policy author's choice, and ledger state is public regardless. |
| C1-D.1 | DoS | `extend_ttl` precedes the predicate check, so a deny could extend TTL | A deny could keep the rule alive "for free" | Low | Medium | `extend_state_ttl` runs BEFORE `evaluate`; every deny panics and the host rolls back the frame including the bump. The bump is guarded on `p.has(&key)` so it never creates state. | None - the rollback is host-guaranteed for `panic_with_error!`. |
| C1-D.2 | DoS | Archive on the doc / nonce / signers_hash / master_set | Persistent entries that archive cannot be re-read; the next install cannot recreate them because the nonce check would loop | Low | High | All four share one lifecycle and are bumped together on the permit path; the doc is re-read on every `enforce`. | Accepted: a rule that is never used for longer than the TTL archives. That is the Soroban state model, not a contract defect. |
| C1-D.3 | DoS | Predicate walk is unbounded | A deeply nested or wide predicate exhausts the host budget | Low | Medium | `decode_with_byte_cap` rejects over `MAX_PREDICATE_BYTES` (32 KB) before parsing; `MAX_DEPTH` 5, `MAX_LEAVES` 200, `MAX_IN_OPERAND_COUNT` 32 are enforced after decode. | None - the byte cap dominates every walk. |
| C1-D.4 | DoS | Per-transaction write-entry cap exceeded at runtime | A predicate that installs and then aborts the host on every enforce | Low | High | **Structurally impossible in this revision.** `enforce` writes no ledger entries at all; the only writes are the four install-time entries and the TTL bump. | None. |
| C1-D.5 | DoS | Hand-crafted predicate installs and denies on every enforce | A predicate that decodes but never permits | Low | Medium | Every evaluation failure surfaces as a `DenyReason` mapped to a `PolicyError`; the deny is a clean revert, not a hang. | None - fails closed. |
| C1-E.1 | Elevation of privilege | Hand-crafted permissive predicate (only literal-vs-literal compares) installs and authorises everything | Bypassing the synth to submit raw bytes | Low | Critical | **Closed on chain.** Install refuses any predicate carrying no selector leaf: `SelectorLeafRequired` 216 (`dsl::has_selector_leaf`). A legitimate time-only predicate (`now < literal`) has a selector leaf and still installs. | None for the "binds nothing" case. See the trust-boundary note for what it still does not promise. |
| C1-E.2 | Elevation of privilege | OZ no-policy rule is all-of-N; POLICED rule is any-of-N | User attaches a POLICED rule expecting "two approvals" by adding a 2nd signer | High | Critical | Surfaced via the review-card `signerNote` whenever `signers.length >= 2`, decoded from the FINAL transaction rather than the input args. The install path also scans the account's other context rules and reports every rule a signer of the new policy could name instead, refusing unless the caller opts in. Off chain only. | Unmitigated at the protocol layer; the note is advisory. Tracked as R-4. |
| C1-E.3 | Elevation of privilege | External verifier in the master set becomes an unrecoverable state | `require_master` calls `require_auth` on the verifier address, which a plain verifier contract never satisfies | Low | Critical | Install and rotate both refuse External signers in the master set (212). | Tracked as R-5: refusing is the correct behaviour, not a limitation. |
| C1-E.4 | Elevation of privilege | `install_nonce` replay between two installs | A replayed install overwrites a fresh predicate | Low | High | `install_nonce` must equal `stored_nonce + 1`; mismatch panics 202. `uninstall` removes the nonce with the rest of the state, so a subsequent install starts again at 1. | None. |
| C1-E.5 | Elevation of privilege | Transitive authority through a permitted callee | The policy permits calling contract X; X then moves funds using a standing SEP-41 allowance the account granted earlier. That transfer needs no auth from this account, so it produces no `Context` and no `enforce` call | Medium | High | **Depth itself is covered:** OZ builds one `Context` per auth-tree node requiring this account's authorisation and calls `enforce` once per context, so a smuggled inner call that needs this account's auth IS evaluated on its own merits. `extract_call` handling only `Context::Contract` is a shape check, not a depth limit. | Residual by nature, not by scope. Mitigated operationally - a policed key must hold zero standing allowances. Tracked as R-3. |
| C1-E.6 | Elevation of privilege | Fatal deny inverted via `not` or `or` | A user-supplied predicate that negates a structural denial | Medium | High | `UnsupportedNode` is fatal: `Not` does not invert it and `Or` short-circuits on it (`src/dsl.rs`). Pinned by a regression test. | None. |
| C1-E.7 | Elevation of privilege | Grammar-version skew between the builder and the contract | An off-chain builder emitting an older `grammar_version` produces installs the contract refuses - or, in the inverse case, a contract that accepts a document written against a different leaf set | Medium | High | `install_params.grammar_version != SELF_VERSION` panics 200. Removing a leaf changes the wire format, so the version was bumped to 2 with the grammar reduction. | None on chain. The off-chain side is the fragile half - see Section 8, finding 1. |

### Data flow F1 - install pipeline (U -> MCP -> synth -> unsigned XDR -> wallet -> chain -> OZ -> interpreter)

| ID | Cat | Threat | Attack scenario | Likelihood | Impact | Mitigation | Residual |
|---|---|---|---|---|---|---|---|
| F1-S.1 | Spoofing | MCP server returns XDR for a different smart account than requested | `install_policy` is the canonical path | Low | Critical | The XDR is built from the caller-supplied `smartAccount` and a `describes` field is produced by decoding the assembled XDR; the user sees the address in the review card. The MCP server holds no key material. | The wallet signature is the user-confirmation step; the user must see and approve the address. |
| F1-T.1 | Tampering | Predicate bytes differ between synth-emit and chain-install | TS encoder and Rust decoder divergence | Low | High | `sha256` over the raw XDR is computed at encode time; the contract re-computes it on receipt and panics 208 on mismatch. The conformance suite pins encoder to decoder. | None. |
| F1-T.2 | Tampering | `authNonce` from a non-pinned RPC binds the caller to the wrong host | Caller supplies an `rpcUrl` other than the pinned URL | Medium | Medium | Default-deny on `rpcUrl` unless `allowUnpinnedRpcUrl: true`; the same gate applies to `revoke_policy` and `get_interpreter_info(verifyLive)`. | None - opt-in is explicit. |
| F1-T.3 | Tampering | `interpreterAddress` is an attacker-controlled contract | The smart account would delegate to an interpreter the caller controls | Low | Critical | `enforceInterpreterPin` runs BEFORE building the XDR; default-deny unless `allowUnpinnedInterpreter: true`. | None - opt-in is explicit. |
| F1-R.1 | Repudiation | Install succeeds but the user denies signing it | Wallet-side record | Low | Low | The XDR is unsigned; the wallet signature is the audit record. The MCP body is stateless and holds no key material. | None at the synth. |
| F1-I.1 | Info disclosure | Install error messages leak internal commentary | A throw's `message` includes source-code rationale | Low | Low | `safeStringify` strips `Error.stack`; message and details lengths are bounded. | None. |
| F1-D.1 | DoS | HTTP transport flooded with large requests | Any caller can hit `POST /mcp` if bound to a non-loopback host | Medium | Medium | Default-bind to loopback; 1 MB body cap; explicit `allowExternalHost: true` opt-in. | The opt-in is the auditable intent. |
| F1-E.1 | Elevation of privilege | `__testPredicateNode` seam in the public type | A downstream consumer bypassing the MCP/CLI gates could supply a permissive test predicate | Low | Critical | The seam lives on `__TestInterpreterAdapterOptions`, not the public options type; a runtime guard throws when `NODE_ENV !== 'test'`. | Mitigated at the seam. |

### Data flow F2 - enforce pipeline (agent key -> OZ -> interpreter)

| ID | Cat | Threat | Attack scenario | Likelihood | Impact | Mitigation | Residual |
|---|---|---|---|---|---|---|---|
| F2-S.1 | Spoofing | Attacker invokes `enforce` directly without going through the smart account | The host is the gate | Medium | High | `smart_account.require_auth()` is the first statement of `enforce`; OZ's `__check_auth` only authorises the call if it routed through the smart account's auth tree. | If OZ's `__check_auth` were broken, the bound moves. |
| F2-T.1 | Tampering | Stored predicate bytes tampered between `install` and `enforce` | Persistent storage is the source of truth | Low | High | Every `enforce` re-decodes via `decode_with_byte_cap`; a tampered or truncated predicate panics 201. | None. |
| F2-T.2 | Tampering | Live signer set changes between installs without rotation | A different signer set silently authorises a permit | Medium | High | At every `enforce`, `sha256(context_rule.signers)` is compared against the value stored at install; mismatch panics 204. | None. |
| F2-R.1 | Repudiation | Permit without signer record | OZ is the audit path | Low | Low | `authenticated_signers` is forwarded to the interpreter; OZ separately enforces the signature map. | None at the interpreter. |
| F2-I.1 | Info disclosure | `DenyReason` codes reveal internal evaluator state | Any observer of host events sees the numeric code | Low | Low | Codes are grouped (1xx evaluator, 2xx install/auth/state) and never renumbered or reused; the numeric codes are a public ABI. Retired codes are not recycled. | None. |
| F2-D.1 | DoS | Evaluation cost grows with predicate size | A large predicate slows every call | Low | Low | Structural caps are enforced at install and re-checked at decode; `enforce` performs no cross-contract calls and no storage writes, so its cost is bounded by the predicate walk alone. | None. |
| F2-E.1 | Elevation of privilege | `enforce` accepts an argument that bypasses the policy | A side-channel to inject a different predicate | Low | Critical | The contract is pure with respect to policy: `enforce` decodes stored bytes and walks the evaluator; there is no path to substitute a predicate. | None. |
| F2-E.2 | Elevation of privilege | Structural deny inverted via `not` / `or` | A user-supplied predicate that negates a fatal denial | Medium | High | `Not` does not invert fatal denials; `Or` short-circuits on a fatal denial. | None. |

### Data flow F3 - MCP HTTP transport

| ID | Cat | Threat | Attack scenario | Likelihood | Impact | Mitigation | Residual |
|---|---|---|---|---|---|---|---|
| F3-S.1 | Spoofing | Attacker supplies a forged `rpcUrl` to bind the auth digest | `verifyLive: true, rpcUrl: '<attacker>'` | Medium | Medium | `enforceRpcPin` runs before the live version lookup when `verifyLive === true`. | None. |
| F3-T.1 | Tampering | JSON-RPC batch request | A malicious batch smuggles extra calls | Low | Low | Array bodies are explicitly rejected. | None. |
| F3-R.1 | Repudiation | Tool-call log missing | Per-call stateless; no log | Low | Low | The wallet signature is the user-confirmation; OZ's auth tree is the audit path. | None. |
| F3-I.1 | Info disclosure | HTTP errors leak host/URL detail | `simulateTransaction` errors echoed | Low | Low | Errors are mapped to short stable reasons; the full payload stays in SDK logs. | None. |
| F3-D.1 | DoS | Non-loopback host exposes unauthenticated tools | `host: '0.0.0.0'` exposes the surface | Medium | Medium | Default-deny on non-loopback hosts; explicit `allowExternalHost: true` opt-in; 1 MB body cap enforced by the streaming reader. | The opt-in is auditable. |
| F3-E.1 | Elevation of privilege | No auth on `/mcp` | Any caller who can reach the port calls the tools | High | High | Default-bind to loopback; no bearer/HMAC exists. A production deployment is expected to gate at a reverse proxy. | Tracked as A-6. Note the three open advisories against the MCP SDK in Section 8. |

### Data flow F4 - policy-synth core (mandate/recording -> IR -> predicate bytes)

| ID | Cat | Threat | Attack scenario | Likelihood | Impact | Mitigation | Residual |
|---|---|---|---|---|---|---|---|
| F4-S.1 | Spoofing | Caller supplies a placeholder/LLM-seam smart-account marker | `VERIFY-*` / `PLACEHOLDER-*` / `TODO-*` | Low | High | The placeholder prefix is rejected before the C.../56-char check. | None. |
| F4-T.1 | Tampering | A `literal_bytes` payload with non-hex chars silently becomes empty | `Buffer.from('zz', 'hex')` returns empty | Low | Medium | Strict even-length hex regex at the MCP boundary; `validateLeafValues` inside `encodePredicate`. | None. |
| F4-T.2 | Tampering | i128 wrapping at encode time | `2^127` overflows | Low | Medium | `scvI128FromDecimal` range-checks; out-of-range values throw at encode time. | None. |
| F4-R.1 | Repudiation | A constraint that "no longer matters" silently removed by `minimize` | Surface reduced silently | Low | High | `runHarness` exercises deny cases before and after minimize; a constraint whose deny case no longer denies fails the harness. | None. |
| F4-I.1 | Info disclosure | Mandate lowering routes `recipients` to the wrong argument for non-SEP-41 methods | A path pinned to `in(args[1], recipients)` | Medium | Medium | The schema refines `recipients` to `method in {transfer, mint}`; the determinism is enforced at the boundary. | None. |
| F4-D.1 | DoS | Predicate depth / leaf count explodes | | Low | Medium | `PREDICATE_CAPS` (depth 5, leaves 200, in-operand 32, 32 KB) enforced at encode and mirrored on the host. | None. |
| F4-D.2 | DoS | ScVal recursion stack overflow | | Low | Medium | `MAX_SCVAL_DEPTH = MAX_SCVAL_CLONE_DEPTH = 30` caps the decoder and the clone paths. | None. |
| F4-E.1 | Elevation of privilege | A hand-crafted predicate of only literal-vs-literal compares installs and permits everything | Bypass the synth and call `buildAddContextRuleArgs` directly | Low | Critical | The synth's `runHarness` fails such a predicate with `DENY_CASE_FAILURE`, **and** the contract now refuses it with 216. Both layers. | Closed - see R-2. |
| F4-E.2 | Elevation of privilege | The off-chain builder emits a `grammar_version` the contract does not speak | Every install fails, or a document is built against the wrong leaf set | Medium | High | `POLICY_INSTALL_PARAM_FIELDS` is the ABI the host unpacks by field count; the version literal is pinned in the `PolicyDocument` type so a skew is a type error at the emitting sites. | A CI test asserts the TS literal equals `SELF_VERSION` parsed from `version.rs`, so a skew fails the build rather than the install. R-8, closed. |

### Element C2 - OpenZeppelin smart-account (out of scope, named with trust assumption)

| ID | Cat | Threat | Attack scenario | Likelihood | Impact | Mitigation | Residual |
|---|---|---|---|---|---|---|---|
| C2-T.1 | Tampering | OZ `__check_auth` re-uses a stale nonce | | Low | High | OZ's nonce bookkeeping is OZ's responsibility. | Trust assumption: OZ is correct. |
| C2-E.1 | Elevation of privilege | OZ's no-policy rule is all-of-N; POLICED rule is any-of-N | Adding a 2nd signer to a rule with a POLICED policy | High | Critical | Surfaced in the review card `signerNote`; the install path scans the account's other rules for authority a signer of this one already holds and refuses unless the caller opts in. | Unmitigated at the protocol layer. Cross-rule authority is tracked as R-7. |

### Element C3 - Pinned Soroban RPC (out of scope, named with trust assumption)

| ID | Cat | Threat | Attack scenario | Likelihood | Impact | Mitigation | Residual |
|---|---|---|---|---|---|---|---|
| C3-S.1 | Spoofing | Compromised RPC returns forged auth nonces and root invocations | The auth digest binds the caller | Medium | High | Pin enforcement is default-deny; the wallet signature covers the same auth digest. | Trust assumption: pinned RPCs are honest. |

### Element C4 - Wallet (out of scope, named with trust assumption)

| ID | Cat | Threat | Attack scenario | Likelihood | Impact | Mitigation | Residual |
|---|---|---|---|---|---|---|---|
| C4-S.1 | Spoofing | Compromised wallet | | Low | Critical | Out of scope. | Trust assumption: the user's wallet is honest. |

---

## 6. Trust assumptions

What this model assumes and does NOT verify:

1. **Stellar validators and protocol.** Transaction ordering, ledger finality and `require_auth` semantics are honoured by the host.
2. **OpenZeppelin smart-account contracts.** `__check_auth`, `add_context_rule`, `remove_context_rule` and signer-threshold semantics are correct.
3. **User's own key custody.** A compromised source-account key signs whatever the wallet presents; the contract does not second-guess the signature.
4. **Soroban SDK 27 cross-contract execution semantics.** The interpreter reads `Context::Contract` only; deeper tree walking is out of scope (modelled as R-3).
5. **Pinned RPC URLs** - assumed honest; the install/revoke auth digests bind to whichever host answered.
6. **TS encoder / Rust decoder parity.** The conformance suite pins this. The TS evaluator and the Rust evaluator agree on deny-vs-permit; reason codes are cross-checked by `runHarness`.

The previous revision's assumption 3 - "Reflector Pulse feeds are honest on most
rounds" - is **withdrawn**: there is no feed.

---

## 7. Residual risks and accepted risks

### Retired in this revision

| ID | Was | Why it is gone |
|---|---|---|
| R-1 | Oracle operator compromise-of-both-feeds beats the within-feed, two-round and cross-feed checks. Previously the design's headline residual, and not closable by us. | The oracle path was removed. The risk is retired with the feature, not accepted or mitigated. |
| R-6 | The oracle circuit breaker was account-scoped but rule-master-gated, so any rule master could pause oracle enforcement across the account. | The circuit breaker existed only to contain a misbehaving feed. With no feed, the entry point and its scoping question are both gone. |

### Residual risks (unmitigated)

| ID | Residual | Why it is accepted |
|---|---|---|
| R-2 | ~~Hand-crafted permissive predicate installs and permits everything.~~ **CLOSED on chain.** The interpreter refuses any predicate carrying no selector leaf: 216 `SELECTOR_LEAF_REQUIRED`. | The check is a standalone walk (`dsl::has_selector_leaf`) run at install. Legitimate non-call constraints still install: a time-only predicate (`now < literal`) has a selector leaf and is pinned by a regression test. The on-chain guarantee is now "evaluated faithfully AND binds something" - see the trust-boundary note below for what it still does not promise. |
| R-3 | Transitive authority: once a policy permits calling contract X, it also permits whatever X can do with authority it ALREADY holds (standing SEP-41 allowances, its own admin rights), because those actions require no further auth from this account and so never produce a `Context`. | Not a gap in the interpreter, and not closable by any auth-based policy layer, Zodiac Roles on EVM included. Every invocation that DOES require this account's auth gets its own `Context` and its own `enforce` call, so depth is covered. Mitigated operationally: a policed key must hold zero standing allowances, so a permitted callee has nothing to abuse. |
| R-4 | OZ no-policy rule is all-of-N; POLICED rule is any-of-N. Adding a 2nd signer "for two approvals" produces the opposite of the intent. | OZ protocol-level semantic, not something the interpreter can override. Delivery of the warning was verified end to end: `signerNote` is set when `signers.length >= 2`, carried on `InstallCallDescribes`, and reachable on the `install_policy` response. It is decoded from the FINAL transaction rather than the input args, so it describes what will actually be signed. Residual: it is advisory text, not a hard gate. A hard gate would need a new field on `PolicyInstallParams` - a wire-format change across the contract, the synthesiser and the conformance fixtures. |
| R-5 | Master signer set cannot include `Signer::External(_, _)` because the interpreter cannot re-implement OZ's verifier protocol in v1. | **No action: refusing is the correct behaviour, not a limitation to fix.** An `External` master would be permanently unrecoverable, since `rotate_master_signer_set` and `uninstall` both gate on `require_master` and neither could ever satisfy it. Refusing at install converts an unrecoverable state into a loud, immediate error. Verified recoverable by contrast: with a valid master set, `rotate` and `uninstall` are direct calls that never route through `enforce`, so an account is never locked out of governing its own rule. |
| R-7 | A signer's effective authority for a given call is the MAXIMUM over every context rule they belong to whose `context_type` matches it. OpenZeppelin documents multiple rules per context type as intended. Adding a tighter rule restricts nothing. | OZ protocol-level semantic. `do_check_auth` enforces only the policies of the rule the caller named, and the rule id is bound into the auth digest, so the signer commits to the rule they exercise. Mitigated off chain: `install_policy` scans the account's other rules, reports every rule a signer of the new policy could name instead, and refuses unless the caller opts in. That mitigation is client-side only. **Reduced in this revision:** with no stateful budgets left in the contract, the "budgets do not aggregate across rules" half of this risk no longer applies - there are no budgets. What remains is the authority-maximum property, which is purely OZ's. |
| R-8 | ~~Grammar-version parity between the Rust contract and the TypeScript builder is maintained by convention, not by a cross-language compile-time check.~~ **CLOSED.** | A skew is loud rather than silent - the contract refuses the install with 200 - but it was live in this codebase until this round (Section 8, finding 1), which is the evidence that convention alone was insufficient. `packages/policy-synth/src/install/grammar-version-parity.test.ts` now parses `pub const SELF_VERSION: u32 = N;` out of `contracts/policy-interpreter/src/version.rs` and asserts it equals `DEFAULT_GRAMMAR_VERSION`. Verified in both directions: it passes on this tree, and injecting `SELF_VERSION = 3` makes it fail. |

### Accepted risks (open, in scope, accepted with reason)

These are live. They are not defects to be fixed before audit; they are decisions.
Struck-through rows were accepted in an earlier revision and have since been
closed; they are kept visible so the change is auditable.

The ids are inherited from the internal threat model this document derives
from, so the sequence has gaps: an id absent here is an entry that does not
apply to this repository, either because it concerns a component this repo does
not contain or because the surface it described was removed in the reduction.

| ID | Accepted risk | Reason |
|---|---|---|
| A-6 | MCP HTTP transport has no authentication. | Mitigated by default-loopback binding plus an explicit `allowExternalHost: true` opt-in. A reverse proxy or firewall is the expected deployment-time auth. The server holds no key material, so the worst case is unsigned-XDR generation, not signing. |
| A-12 | `argument_reorder` excluded from synth deny-case generation. | The Soroban host dispatches by function identity with positional args, so a reordered-argument call is a different call the predicate already fails to match. |
| A-13 | OZ primitive instance addresses (`spending_limit`, `simple_threshold`, `weighted_threshold`) not pinned in this repo. | They are `VERIFY-oz-*` placeholders in the OZ adapter. A user must source them from the audited OZ Accounts deployment; pinning another project's addresses here would create a false assurance. |
| A-14 | ~~`bun audit` and `cargo audit` are not wired into CI.~~ **CLOSED.** | `.github/workflows/ci.yml` now runs `bun audit` in the TypeScript job and `cargo audit` in the contracts job. The same pass removed `test-oracle` from the contracts matrix: that crate no longer exists, so every CI run would have failed on it. |
| A-15 | ~~Three high-severity advisories are open against `@modelcontextprotocol/sdk` 1.18.1.~~ **CLOSED.** | The SDK is pinned at 1.30.0 in both the workspace root and `packages/policy-builder-mcp`, and `bun audit` reports no vulnerabilities. GHSA-345p-7cg4-v4c7 was not only a version number: it describes cross-client reuse of one server/transport instance, and the HTTP transport did exactly that. It now builds both per request. See `docs/audit/README.md` finding 1. |
| A-16 | The reduced contract is not the deployed mainnet binary. | This grammar is version 2; the address pinned in `run/schemas.ts` runs version 1 with the oracle path. Auditing this tree therefore says nothing about the currently deployed contract. This is only legitimate if the reduced version becomes the shipped product - an open governance question, not a technical one. |

### Trust-boundary note: what the on-chain component actually guarantees

Stated plainly because the architecture invites a stronger reading than the code
supports.

The design is "one immutable, audited interpreter; policy is data". The natural
inference is that installing a policy through the audited contract makes the
resulting authorisation restrictive. It does not, on its own. The interpreter
guarantees three things:

1. the predicate it was given is **evaluated faithfully**;
2. it **fails closed** on every error path;
3. since this revision, the predicate **binds at least one property of the call**
   (216).

It does not guarantee that the predicate binds the *right* properties. A
predicate that pins only `call_fn` permits that function with any arguments.
Whether a policy is tight enough for its purpose is established off chain, by
`runHarness` and the review card, and ultimately by the person approving the
wallet signature.

### What the contract no longer promises

The reduction removed capability, and saying so plainly is part of the model:

- **Call frequency is not bounded.** There is no "at most N calls per window".
  A policed key may make an unlimited number of calls that satisfy the
  predicate. The synthesiser surfaces this explicitly on incoming-only flows
  (`FREQUENCY_BOUND_MISSING`) rather than implying a cap it cannot keep.
- **Value moved is not bounded by the interpreter.** It never was - the
  interpreter sees one authorised call, not token movements. Rolling spend caps
  remain the OZ `spending_limit` primitive's job.
- **Policy expiry is not enforced by the interpreter.** It is the context rule's
  `valid_until`, owned by the smart account.
- **There is no price-conditioned authorisation.**

An operator who needs any of these must obtain them from OZ built-ins, from a
different layer, or not at all. The honest statement is that this contract
answers one question well: *is this specific call one the policy permits?*

---

## 8. Did we do a good job? (Stellar template closing reflection)

### What this round found

1. **A live cross-layer defect.** The contract's `SELF_VERSION` had been bumped
   to 2 with the grammar reduction, but the off-chain builder still emitted
   `grammar_version: 1`. The contract refuses a mismatch fail-closed, so **every
   install the toolkit produced would have failed on chain**. Fixed at four
   production sites, and R-8 now pins the parity in CI so it cannot recur.
2. **An auto-generated artifact that could not be regenerated.** The conformance
   fixture's documented inputs lived in `/tmp` on one machine, and the generator
   emitted a struct field the contract no longer had - so regenerating produced
   Rust that does not compile. The generator now synthesises its input in-process
   from a checked-in recording, and the fixture header records the exact command.
3. **A latent uninstallable-predicate path.** The interpreter adapter lowered an
   IR `valid_until` selector into a predicate leaf the contract refuses at
   install. It is now reported as uncovered instead.
4. **Test code is not typechecked.** `tsconfig` excludes `src/**/*.test.ts`, so
   `bun run typecheck` never sees test files. This is why 50 tests could
   reference removed symbols while typecheck stayed green. Flagged, not changed.
5. **40 orphaned test snapshots**, 8 of which were already dead at the initial
   import.
6. **A cross-client instance-reuse defect in the MCP HTTP transport.** Closing
   A-15 surfaced it: GHSA-345p-7cg4-v4c7 is not a patch-and-move-on advisory but
   a description of a code pattern, and this transport used it - one `McpServer`
   and one `StreamableHTTPServerTransport` built at startup and shared by every
   request. SDK 1.30.0 refuses to reuse a stateless transport at runtime, which
   is how it was caught. Both are now built per request and closed when the
   response closes, and a regression test asserts that eight concurrent clients
   each get their own JSON-RPC id back.
7. **A CI job that could never have passed.** The contracts matrix still listed
   `test-oracle`, a crate deleted with the oracle path.

### Tool evidence

All logs in `docs/audit/evidence/` were produced against this tree:

| Tool | Result |
|---|---|
| `cargo fmt --check`, `clippy -D warnings`, `cargo test`, conformance, wasm build | clean; 94 + 6 tests pass |
| `biome check`, `tsc --noEmit`, `bun test` | clean; 839 pass, 1 skip, 0 fail |
| `cargo audit` | 0 vulnerabilities across 202 crates; 1 unmaintained-crate warning |
| `bun audit` | 0 vulnerabilities |
| `clippy -W pedantic -W nursery` | 228 style warnings, 0 security |
| `cargo scout-audit` | Analyzed: 2 Critical, 9 Medium, 1 Enhancement - all triaged, both Criticals false positives |
| Stellar Security Portal corpus | 832 real Soroban findings; 150 critical/high cross-checked against this contract's five entry points |

Scout's two Criticals are `d + 1` in the AST depth walk. They are unreachable:
the 32 KB byte cap is checked before parsing, bounding depth eight orders of
magnitude below `u32::MAX`. Scout reports raw operators without following the
dominating guard.

### Where the model is weakest

- **The reduced contract is not the deployed one** (A-16). This is the single
  most important caveat on the whole document.
- **R-3 and R-4 are structural**, inherited from the account model rather than
  from this contract, and no amount of interpreter work closes them.
- **The off-chain half carries more risk than the on-chain half.** The contract
  is 1,225 nSLOC and stateless; the toolchain is ~8,500 nSLOC, holds the
  default-deny install gates, and is where the grammar-parity defect lived.
- **Coverage of the MCP transport is thin** because the deployment model
  (loopback stdio) makes the HTTP surface a secondary path. If that changes, F3
  needs re-work and A-6 becomes load-bearing. This round found a real defect on
  that thin path (finding 6 above), which is the argument for widening it.

### What would raise confidence further

1. Deploy the reduced grammar and re-pin, closing A-16 - the only one of this
   list still open, and the one this document cannot close by itself.

The other three items this section carried in the previous revision have been
done: the grammar-parity CI assertion (R-8), `cargo audit` and `bun audit` in
CI (A-14), and the SDK bump past 1.25.3 (A-15).
