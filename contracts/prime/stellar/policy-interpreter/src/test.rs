use soroban_sdk::Env;

use crate::{PolicyInterpreter, PolicyInterpreterClient, SELF_VERSION};

/// The deployed wasm must report the grammar it implements, so a caller can
/// verify the contract at an address agrees with the manifest it was chosen
/// from.
#[test]
fn reports_its_grammar_version() {
    let e = Env::default();
    let id = e.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&e, &id);
    assert_eq!(client.grammar_version(), SELF_VERSION);
}

/// The literal, not the constant: grammar 6 adds the `call_arg_field_at`
/// leaf, which changes what a predicate can address. A v5 builder must not
/// read this build's answer as an invitation to install.
#[test]
fn grammar_version_is_six() {
    assert_eq!(SELF_VERSION, 6);
}
