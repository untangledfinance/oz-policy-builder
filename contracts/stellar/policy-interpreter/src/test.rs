use soroban_sdk::{Bytes, Env};

use crate::dsl::{self, DecodeError, EvalContext, EvalDecision, Node};
use crate::{Limits, PolicyInterpreter, PolicyInterpreterClient, SELF_VERSION};

/// What grammar 7 shipped with (`tests/common` holds the same for the integration suites).
pub const DEFAULT: Limits = Limits {
    max_reads: 4,
    max_leaves: 200,
    max_predicate_bytes: 32 * 1024,
    max_elems: 32,
    max_in_operands: 32,
    max_depth: 5,
};

/// `dsl::decode` and `dsl::evaluate` at the default limits, which the unit tests
/// of the grammar run under (`tests/limits.rs` covers every other setting).
pub fn decode(env: &Env, bytes: &Bytes) -> Result<Node, DecodeError> {
    dsl::decode(env, bytes, &DEFAULT)
}

pub fn evaluate(env: &Env, node: &Node, call: &EvalContext) -> EvalDecision {
    dsl::evaluate(env, node, call, &DEFAULT)
}

/// The deployed wasm must report the grammar it implements, so a caller can
/// verify the contract at an address agrees with the manifest it was chosen
/// from.
#[test]
fn reports_its_grammar_version() {
    let e = Env::default();
    let id = e.register(PolicyInterpreter, (DEFAULT,));
    let client = PolicyInterpreterClient::new(&e, &id);
    assert_eq!(client.grammar_version(), SELF_VERSION);
}

/// The literal, not the constant: grammar 7 adds `read` and `now` and replaces
/// `call_arg_scaled`, which changes what a predicate can say. A v6 builder must
/// not read this build's answer as an invitation to install.
#[test]
fn grammar_version_is_seven() {
    assert_eq!(SELF_VERSION, 7);
}
