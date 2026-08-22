//! ABI conformance against the OpenZeppelin smart account.
//!
//! Everything else in this suite builds our own types on both sides of a
//! call, so it can only prove the contract is self-consistent. These tests
//! build the wire shapes INDEPENDENTLY - as host maps keyed by the field
//! names OZ uses - and decode them into our types. A drift in either
//! direction fails here instead of only failing on chain.
//!
//! Shapes are pinned against OpenZeppelin/stellar-contracts at 4114bb8:
//!   - `ContextRule`     - accounts/src/smart_account/storage.rs
//!   - `ContextRuleType` - same file, lines 170-177
//!   - `Signer`          - accounts/src/smart_account/mod.rs

extern crate alloc;

use policy_interpreter::{ContextRule, PolicyInterpreter, PolicyInterpreterClient, Signer};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{
    Address, Env, IntoVal, Map, String as SorobanString, Symbol, TryFromVal, Val, Vec,
};

/// Build the `ContextRule` map exactly as the smart account sends it, without
/// referencing our struct. Field names and order come from the pinned source.
fn oz_context_rule_val(env: &Env, id: u32, signers: &Vec<Signer>) -> Val {
    let mut m: Map<Symbol, Val> = Map::new(env);
    m.set(Symbol::new(env, "id"), id.into_val(env));
    m.set(
        Symbol::new(env, "context_type"),
        oz_default_context_type(env),
    );
    m.set(
        Symbol::new(env, "name"),
        SorobanString::from_str(env, "agent-rule").into_val(env),
    );
    m.set(Symbol::new(env, "signers"), signers.into_val(env));
    m.set(
        Symbol::new(env, "signer_ids"),
        Vec::<u32>::new(env).into_val(env),
    );
    m.set(
        Symbol::new(env, "policies"),
        Vec::<Address>::new(env).into_val(env),
    );
    m.set(
        Symbol::new(env, "policy_ids"),
        Vec::<u32>::new(env).into_val(env),
    );
    m.set(
        Symbol::new(env, "valid_until"),
        Option::<u32>::None.into_val(env),
    );
    m.into_val(env)
}

/// `ContextRuleType::Default` - a unit variant encodes as the 1-element vec
/// `[Symbol("Default")]`.
fn oz_default_context_type(env: &Env) -> Val {
    let mut v: Vec<Val> = Vec::new(env);
    v.push_back(Symbol::new(env, "Default").into_val(env));
    v.into_val(env)
}

/// `Signer::Delegated(addr)` - a tuple variant encodes as
/// `[Symbol("Delegated"), addr]`.
fn oz_delegated_signer_val(env: &Env, addr: &Address) -> Val {
    let mut v: Vec<Val> = Vec::new(env);
    v.push_back(Symbol::new(env, "Delegated").into_val(env));
    v.push_back(addr.into_val(env));
    v.into_val(env)
}

#[test]
fn oz_context_rule_decodes_into_ours() {
    let env = Env::default();
    let signer_addr = Address::generate(&env);
    let signers: Vec<Signer> = soroban_sdk::vec![&env, Signer::Delegated(signer_addr.clone())];

    let raw = oz_context_rule_val(&env, 7, &signers);
    let decoded = ContextRule::try_from_val(&env, &raw)
        .expect("the smart account's ContextRule must decode - a subset traps on chain");

    assert_eq!(decoded.id, 7);
    assert_eq!(decoded.signers.len(), 1);
    assert_eq!(decoded.valid_until, None);
}

#[test]
fn oz_signer_variants_decode_into_ours() {
    let env = Env::default();
    let addr = Address::generate(&env);

    let delegated = Signer::try_from_val(&env, &oz_delegated_signer_val(&env, &addr))
        .expect("Signer::Delegated must decode");
    match delegated {
        Signer::Delegated(a) => assert_eq!(a, addr),
        other => panic!("expected Delegated, got {other:?}"),
    }

    // External(Address, Bytes)
    let mut ext: Vec<Val> = Vec::new(&env);
    ext.push_back(Symbol::new(&env, "External").into_val(&env));
    ext.push_back(addr.to_val());
    let sig_bytes = soroban_sdk::Bytes::from_array(&env, &[1u8, 2, 3]);
    ext.push_back(sig_bytes.into_val(&env));
    let ext_val: Val = ext.into_val(&env);
    let external = Signer::try_from_val(&env, &ext_val).expect("Signer::External must decode");
    assert!(matches!(external, Signer::External(_, _)));
}

#[test]
#[should_panic(expected = "UnexpectedSize")]
fn a_context_rule_missing_a_field_is_rejected() {
    // Guards the guard: if a short map DID decode, the test above would prove
    // nothing. Drop `policy_ids` and the decode must fail. The host raises
    // UnexpectedSize and the conversion panics rather than returning Err -
    // which is exactly what a real call would do on chain.
    let env = Env::default();
    let signers: Vec<Signer> = soroban_sdk::vec![&env, Signer::Delegated(Address::generate(&env))];
    let mut m: Map<Symbol, Val> = Map::new(&env);
    m.set(Symbol::new(&env, "id"), 1u32.into_val(&env));
    m.set(
        Symbol::new(&env, "context_type"),
        oz_default_context_type(&env),
    );
    m.set(
        Symbol::new(&env, "name"),
        SorobanString::from_str(&env, "r").into_val(&env),
    );
    m.set(Symbol::new(&env, "signers"), signers.into_val(&env));
    m.set(
        Symbol::new(&env, "signer_ids"),
        Vec::<u32>::new(&env).into_val(&env),
    );
    m.set(
        Symbol::new(&env, "policies"),
        Vec::<Address>::new(&env).into_val(&env),
    );
    m.set(
        Symbol::new(&env, "valid_until"),
        Option::<u32>::None.into_val(&env),
    );
    let raw: Val = m.into_val(&env);
    let _ = ContextRule::try_from_val(&env, &raw);
}

#[test]
fn enforce_accepts_a_rule_built_the_way_the_smart_account_builds_it() {
    // The end-to-end point: drive the real entry point with an
    // independently-constructed rule, so argument binding is exercised rather
    // than assumed.
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyInterpreter, ());
    let client = PolicyInterpreterClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let signers: Vec<Signer> = soroban_sdk::vec![&env, Signer::Delegated(smart_account.clone())];

    let rule =
        ContextRule::try_from_val(&env, &oz_context_rule_val(&env, 1, &signers)).expect("decodes");

    // Install through the decoded rule, then enforce through it.
    let predicate = always_true_predicate(&env, &smart_account);
    let predicate_hash: soroban_sdk::BytesN<32> = env.crypto().sha256(&predicate).into();
    client.install(
        &policy_interpreter::PolicyInstallParams {
            grammar_version: 4,
            install_nonce: 1,
            predicate,
            predicate_hash,
        },
        &rule,
        &smart_account,
    );

    let ctx = soroban_sdk::auth::Context::Contract(soroban_sdk::auth::ContractContext {
        contract: smart_account.clone(),
        fn_name: Symbol::new(&env, "transfer"),
        args: Vec::new(&env),
    });
    assert!(
        client
            .try_enforce(&ctx, &signers, &rule, &smart_account)
            .is_ok(),
        "enforce must bind an OZ-shaped ContextRule"
    );
}

/// `eq(call_contract, <addr>)` - permits when the call targets `addr`.
fn always_true_predicate(env: &Env, addr: &Address) -> soroban_sdk::Bytes {
    use soroban_sdk::xdr::{ScVal, ToXdr, VecM};
    let addr_scval = ScVal::try_from_val(env, &addr.to_val()).expect("address to ScVal");
    let items: alloc::vec::Vec<ScVal> = alloc::vec![
        ScVal::Symbol(soroban_sdk::xdr::ScSymbol(
            b"eq".to_vec().try_into().unwrap()
        )),
        ScVal::Vec(Some(soroban_sdk::xdr::ScVec(
            alloc::vec![ScVal::Symbol(soroban_sdk::xdr::ScSymbol(
                b"call_contract".to_vec().try_into().unwrap()
            ))]
            .try_into()
            .unwrap()
        ))),
        addr_scval,
    ];
    let v: VecM<ScVal> = items.try_into().unwrap();
    let root = ScVal::Vec(Some(soroban_sdk::xdr::ScVec(v)));
    let val: Val = root.into_val(env);
    val.to_xdr(env)
}

// ---- byte-level fixture from OpenZeppelin's ACTUAL type ----
//
// The maps above are hand-built from the pinned source, which is a mirror and
// can drift the same way the original bug did. These bytes are not a mirror:
// they were emitted by encoding OZ's REAL `ContextRule` from
// `stellar-accounts` at commit 4114bb8, then pasted here. Decoding them exercises the exact wire form
// a deployed smart account produces.
//
// Regenerate by building a scratch crate that depends on
// `stellar-accounts` and printing `rule.into_val(&env).to_xdr(&env)` as hex.
//
// Note this also crosses an SDK boundary: OZ pins soroban-sdk 26.1.0 and this
// crate is on 27.0.2. ScVal is protocol-level, so the encodings agree - which
// is worth pinning rather than assuming, since a divergence would break every
// call.

const OZ_CONTEXT_RULE_XDR: &str = "0000001100000001000000080000000f0000000c636f6e746578745f747970650000001000000001000000010000000f0000000744656661756c74000000000f000000026964000000000003000000070000000f000000046e616d650000000e0000000a6167656e742d72756c6500000000000f00000008706f6c69636965730000001000000001000000000000000f0000000a706f6c6963795f69647300000000001000000001000000000000000f0000000a7369676e65725f69647300000000001000000001000000000000000f000000077369676e657273000000001000000001000000010000001000000001000000020000000f0000000944656c656761746564000000000000120000000100000000000000000000000000000000000000000000000000000000000000010000000f0000000b76616c69645f756e74696c0000000001";

const OZ_SIGNER_XDR: &str = "0000001000000001000000020000000f0000000944656c65676174656400000000000012000000010000000000000000000000000000000000000000000000000000000000000001";

fn from_hex(env: &Env, hex: &str) -> soroban_sdk::Bytes {
    let mut b = soroban_sdk::Bytes::new(env);
    let raw = hex.as_bytes();
    let mut i = 0;
    while i < raw.len() {
        let hi = (raw[i] as char).to_digit(16).expect("hex") as u8;
        let lo = (raw[i + 1] as char).to_digit(16).expect("hex") as u8;
        b.push_back((hi << 4) | lo);
        i += 2;
    }
    b
}

#[test]
fn the_real_oz_context_rule_bytes_decode_into_ours() {
    use soroban_sdk::xdr::FromXdr;
    let env = Env::default();
    let raw = from_hex(&env, OZ_CONTEXT_RULE_XDR);
    let val = Val::from_xdr(&env, &raw).expect("OZ ContextRule bytes must parse");
    let decoded =
        ContextRule::try_from_val(&env, &val).expect("OZ's real ContextRule must decode into ours");

    assert_eq!(decoded.id, 7);
    assert_eq!(decoded.signers.len(), 1);
    assert_eq!(decoded.signer_ids.len(), 0);
    assert_eq!(decoded.policies.len(), 0);
    assert_eq!(decoded.policy_ids.len(), 0);
    assert_eq!(decoded.valid_until, None);
    assert_eq!(decoded.name, SorobanString::from_str(&env, "agent-rule"));
    assert!(matches!(
        decoded.context_type,
        policy_interpreter::ContextRuleType::Default
    ));
}

#[test]
fn the_real_oz_signer_bytes_decode_into_ours() {
    use soroban_sdk::xdr::FromXdr;
    let env = Env::default();
    let raw = from_hex(&env, OZ_SIGNER_XDR);
    let val = Val::from_xdr(&env, &raw).expect("OZ Signer bytes must parse");
    let decoded = Signer::try_from_val(&env, &val).expect("OZ's real Signer must decode into ours");
    assert!(matches!(decoded, Signer::Delegated(_)));
}
