use execution_adapter::{policy_args, Call};
use policy_interpreter::{dsl, state};
use soroban_sdk::{
    auth::{Context, ContractContext},
    xdr::{FromXdr, ToXdr},
    Address, Bytes, Env, Symbol, TryFromVal, Val, Vec,
};

#[test]
fn typescript_projection_and_policy_match_rust_for_nested_and_object_values() {
    let e = Env::default();
    let request = Vec::<Val>::from_xdr(
        &e,
        &Bytes::from_slice(&e, include_bytes!("fixtures/projection-request.xdr")),
    )
    .unwrap();
    let prime = Address::try_from_val(&e, &request.get(0).unwrap()).unwrap();
    let interpreter = Address::try_from_val(&e, &request.get(1).unwrap()).unwrap();
    let calls = Vec::<Call>::try_from_val(&e, &request.get(2).unwrap()).unwrap();
    let contexts = Vec::<ContractContext>::try_from_val(&e, &request.get(3).unwrap()).unwrap();
    let args = policy_args(&e, &prime, &interpreter, &calls, &contexts);
    assert_eq!(
        args.clone().to_xdr(&e),
        Bytes::from_slice(&e, include_bytes!("fixtures/projection-args.xdr"))
    );
    let predicate = dsl::decode_with_byte_cap(
        &e,
        &Bytes::from_slice(&e, include_bytes!("fixtures/projection-policy.xdr")),
    )
    .unwrap();
    let mut context = Context::Contract(ContractContext {
        contract: prime,
        fn_name: Symbol::new(&e, "execute"),
        args,
    });
    assert!(matches!(
        dsl::evaluate(&e, &predicate, &state::build_eval_context(&e, &context)),
        dsl::EvalDecision::Permit
    ));
    if let Context::Contract(c) = &mut context {
        c.fn_name = Symbol::new(&e, "other");
    }
    assert!(!matches!(
        dsl::evaluate(&e, &predicate, &state::build_eval_context(&e, &context)),
        dsl::EvalDecision::Permit
    ));
}
