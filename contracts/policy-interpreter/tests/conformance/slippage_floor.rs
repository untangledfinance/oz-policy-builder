//! Hand-crafted conformance fixture for the `call_arg_scaled` slippage
//! floor leaf.
//!
//! The recording-driven `_generated.rs` covers the Blend policy grammar.
//! This file locks the slippage-floor parity between Rust and the TS
//! reference evaluator (`packages/policy-synth/src/synth/evaluate.ts`) on
//! the cases the review card and audits care about: the boundary, the
//! overflow, and the symmetric form. Each test asserts the SPECIFIC Rust
//! verdict against the SPECIFIC string the TS model produces (locked in
//! TS by `evaluate.test.ts`); a divergence fails here.
//!
//! The wire hex below is the EXACT bytes the TS encoder emits. We use a
//! small TS script (left in /tmp during development) to produce the
//! bytes, then paste them here verbatim. If the Rust decoder rejects
//! these bytes, the `decode` call asserts on the get-go and the test
//! fails LOUDLY - the conformance contract is "the bytes the TS side
//! emits must round-trip on Rust", not "the bytes the Rust side likes
//! are accepted".

extern crate alloc;

use alloc::vec::Vec as StdVec;

use policy_interpreter::dsl::{EvalContext, EvalDecision, Node};
use soroban_sdk::{Address, Bytes, Env, Symbol};

use super::_helpers::{build_args, hex_decode_to_bytes};

/// Canonical wire hex of `gte(call_arg[1], call_arg_scaled(0, 95, 100))`,
/// produced by the TS encoder at
/// `packages/policy-synth/src/predicate/encode.ts` (call_arg_scaled arm).
/// Predicate hash: `ea002f8c7333facd1f7601f6cfb7450be860ad46a8cd814752638d4c8689e960`.
const PREDICATE_GTE_HEX: &str = "0000001000000001000000030000000f00000003677465000000001000000001000000020000000f0000000863616c6c5f61726700000003000000010000001000000001000000040000000f0000000f63616c6c5f6172675f7363616c65640000000003000000000000000a0000000000000000000000000000005f0000000a00000000000000000000000000000064";

/// Canonical wire hex of `lte(call_arg_scaled(0, 95, 100), call_arg[1])`,
/// produced by the same TS encoder.
const PREDICATE_LTE_HEX: &str = "0000001000000001000000030000000f000000036c7465000000001000000001000000040000000f0000000f63616c6c5f6172675f7363616c65640000000003000000000000000a0000000000000000000000000000005f0000000a000000000000000000000000000000640000001000000001000000020000000f0000000863616c6c5f6172670000000300000001";

fn load_predicate(env: &Env, hex: &str) -> Node {
    let bytes: Bytes = hex_decode_to_bytes(env, hex);
    policy_interpreter::dsl::decode(env, &bytes)
        .expect("TS-encoded call_arg_scaled predicate must decode in Rust")
}

fn ctx_with_args(env: &Env, args_hex: &[&str]) -> EvalContext {
    let args = build_args(env, args_hex);
    EvalContext {
        contract: Address::from_str(
            env,
            "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD",
        ),
        fn_name: Symbol::new(env, "swap"),
        args,
        at_ledger: 100,
        valid_until_ledger: Some(200),
        now_seconds: 1_000,
        invocation_count_by_window: StdVec::new(),
        oracle_price_by_asset: StdVec::new(),
    }
}

// args[i] = Framed ScVal wire hex for `i128(1000)` / `i128(950)` / `i128(949)`.
// Generated via `xdr.ScVal.scvI128(...).toXDR().toString('hex')` from the
// TS encoder used by `gen-conformance-fixture.ts` (the same one that
// produces the bytes the existing `_generated.rs` uses).
const ARG_1000: &str = "0000000a000000000000000000000000000003e8";
const ARG_950: &str = "0000000a000000000000000000000000000003b6";
const ARG_949: &str = "0000000a000000000000000000000000000003b5";
// i128::MAX; multiplied by any positive num this overflows at the
// `checked_mul` step and denies `ARITHMETIC_OVERFLOW` (matched by the
// TS model's `evalScaledArgCompare` path).
const ARG_I128_MAX: &str = "0000000a7fffffffffffffffffffffffffffffff";

#[test]
fn rust_decoder_accepts_ts_encoded_call_arg_scaled_bytes() {
    // The single most important assertion: the Rust decoder accepts the
    // EXACT bytes the TS encoder emits. If this fails, the surface
    // drifted and TS-side encodes will not round-trip on-chain.
    let env = Env::default();
    let _root = load_predicate(&env, PREDICATE_GTE_HEX);
}

#[test]
fn slippage_floor_permits_at_exact_boundary() {
    // args = [1000, 950]. 1000 * 95 / 100 = 950. Gte 950 >= 950 => permit.
    let env = Env::default();
    let root = load_predicate(&env, PREDICATE_GTE_HEX);
    let ctx = ctx_with_args(&env, &[ARG_1000, ARG_950]);
    match policy_interpreter::dsl::evaluate(&env, &root, &ctx) {
        EvalDecision::Permit => {}
        EvalDecision::Deny(r) => panic!(
            "expected permit (TS verdict), Rust denied with: {}",
            r.code()
        ),
    }
}

#[test]
fn slippage_floor_denies_one_stroop_below_with_slippage_floor() {
    // args = [1000, 949]. 1000 * 95 / 100 = 950. Gte 949 >= 950 => deny.
    let env = Env::default();
    let root = load_predicate(&env, PREDICATE_GTE_HEX);
    let ctx = ctx_with_args(&env, &[ARG_1000, ARG_949]);
    match policy_interpreter::dsl::evaluate(&env, &root, &ctx) {
        EvalDecision::Deny(r) => assert_eq!(r.code(), "SLIPPAGE_FLOOR"),
        EvalDecision::Permit => panic!("expected SLIPPAGE_FLOOR; Rust permitted"),
    }
}

#[test]
fn slippage_floor_holds_for_the_symmetric_lte_form() {
    // The symmetric form: `lte(call_arg_scaled(0, 95, 100), call_arg[1])`.
    // Same args, same verdict - the parity contract extends to the Lte
    // shape so a policy that phrases the floor the other way still works.
    let env = Env::default();
    let root = load_predicate(&env, PREDICATE_LTE_HEX);
    let ctx = ctx_with_args(&env, &[ARG_1000, ARG_950]);
    match policy_interpreter::dsl::evaluate(&env, &root, &ctx) {
        EvalDecision::Permit => {}
        EvalDecision::Deny(r) => panic!(
            "expected permit (TS verdict), Rust denied with: {}",
            r.code()
        ),
    }
}

#[test]
fn slippage_floor_overflow_denies_arithmetic_overflow_not_panic() {
    // args[0] = i128::MAX. With ratio num=2, den=1, the multiplication
    // overflows i128. The TS evaluator returns ARITHMETIC_OVERFLOW
    // (locked in evaluate.test.ts). The Rust contract must match - and
    // MUST NOT panic the frame (the Soroban sdk would treat a panic as
    // a transaction failure, not an evaluator-driven deny).
    let env = Env::default();
    let root = load_predicate(&env, PREDICATE_GTE_HEX);
    // Build an arg-set where the in (args[0]) is i128::MAX and the
    // out (args[1]) is anything - the overflow happens at the scaled
    // leaf, before the comparison can fail or pass.
    let ctx = ctx_with_args(&env, &[ARG_I128_MAX, ARG_950]);
    let d = policy_interpreter::dsl::evaluate(&env, &root, &ctx);
    match d {
        EvalDecision::Deny(r) => assert_eq!(r.code(), "ARITHMETIC_OVERFLOW"),
        EvalDecision::Permit => panic!("expected ARITHMETIC_OVERFLOW; Rust permitted"),
    }
}
