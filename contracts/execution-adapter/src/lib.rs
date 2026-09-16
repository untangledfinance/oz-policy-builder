#![no_std]
//! Stateless, per-Prime execution. No allowance to the adapter is required.
use soroban_sdk::{
    auth::{Context, ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractimpl, contracttype, vec,
    xdr::ToXdr,
    Address, Bytes, Env, IntoVal, Map, Symbol, TryFromVal, Val, Vec,
};

#[contracttype]
#[derive(Clone)]
pub struct Call {
    pub target: Address,
    pub function_name: Symbol,
    pub args: Vec<Val>,
    pub executor_authorizations: Vec<InvokerContractAuthEntry>,
}

/// Deploy with Prime as deployer and SHA256 of this domain as salt, no constructor.
pub fn execution_address(e: &Env, prime: &Address) -> Address {
    let salt = e
        .crypto()
        .sha256(&Bytes::from_slice(e, b"prime.execution.adapter.v1"));
    e.deployer()
        .with_address(prime.clone(), salt)
        .deployed_address()
}

#[contract]
pub struct ExecutionAdapter;

#[contractimpl]
impl ExecutionAdapter {
    pub fn execute(
        e: Env,
        prime: Address,
        interpreter: Address,
        calls: Vec<Call>,
        prime_contexts: Vec<ContractContext>,
    ) -> Vec<Val> {
        assert_eq!(
            e.current_contract_address(),
            execution_address(&e, &prime),
            "wrong Prime"
        );
        assert!(!calls.is_empty() && calls.len() <= 8, "batch size");
        assert!(prime_contexts.len() <= 16, "context count");
        let mut auth_count = 0;
        for call in calls.iter() {
            venue_target(&e, &prime, &interpreter, &call.target);
            check_auths(
                &e,
                &prime,
                &interpreter,
                &call.executor_authorizations,
                0,
                &mut auth_count,
            );
        }
        for context in prime_contexts.iter() {
            venue_target(&e, &prime, &interpreter, &context.contract);
        }
        let args = policy_args(&e, &prime, &interpreter, &calls, &prime_contexts);
        let mut contexts = vec![
            &e,
            ContractContext {
                contract: e.current_contract_address(),
                fn_name: Symbol::new(&e, "execute"),
                args: args.clone(),
            },
        ];
        // Direct call contexts are derived, never supplied twice by the caller.
        for call in calls.iter() {
            contexts.push_back(ContractContext {
                contract: call.target,
                fn_name: call.function_name,
                args: call.args,
            });
        }
        contexts.append(&prime_contexts);
        let mut grants = Vec::new(&e);
        for context in contexts {
            grants.push_back(InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: interpreter.clone(),
                    fn_name: Symbol::new(&e, "enforce"),
                    args: (prime.clone(), Context::Contract(context)).into_val(&e),
                },
                sub_invocations: Vec::new(&e),
            }));
        }
        // The next auth frame must consume these grants; no intervening contract call.
        e.authorize_as_current_contract(grants);
        prime.require_auth_for_args(args);
        let mut results = Vec::new(&e);
        for call in calls {
            if !call.executor_authorizations.is_empty() {
                e.authorize_as_current_contract(call.executor_authorizations);
            }
            results.push_back(e.invoke_contract::<Val>(
                &call.target,
                &call.function_name,
                call.args,
            ));
        }
        results
    }
}

fn venue_target(e: &Env, prime: &Address, interpreter: &Address, target: &Address) {
    assert!(
        target != prime && target != interpreter && target != &e.current_contract_address(),
        "management target"
    );
}

fn check_auths(
    e: &Env,
    prime: &Address,
    interpreter: &Address,
    entries: &Vec<InvokerContractAuthEntry>,
    depth: u32,
    count: &mut u32,
) {
    assert!(depth <= 8, "authorization depth");
    for entry in entries {
        *count += 1;
        assert!(*count <= 32, "authorization count");
        match entry {
            InvokerContractAuthEntry::Contract(call) => {
                venue_target(e, prime, interpreter, &call.context.contract);
                check_auths(
                    e,
                    prime,
                    interpreter,
                    &call.sub_invocations,
                    depth + 1,
                    count,
                );
            }
            _ => panic!("contract creation authorization"),
        }
    }
}

/// V1 projection of the COMPLETE request for existing v5 selectors.
/// The shape digest commits to types, boundaries and ordering; leaves stay inspectable.
/// Non-v5 scalar types are represented by their exact XDR digest (two i128 limbs).
pub fn policy_args(
    e: &Env,
    prime: &Address,
    interpreter: &Address,
    calls: &Vec<Call>,
    prime_contexts: &Vec<ContractContext>,
) -> Vec<Val> {
    let mut shape = vec![e, 1u32];
    let mut leaves = Vec::new(e);
    flatten(
        e,
        (prime, interpreter, calls, prime_contexts).into_val(e),
        &mut shape,
        &mut leaves,
        0,
    );
    let mut result = digest_limbs(e, shape.to_xdr(e));
    result.append(&leaves);
    result
}

fn digest_limbs(e: &Env, bytes: Bytes) -> Vec<Val> {
    let h = e.crypto().sha256(&bytes).to_array();
    vec![
        e,
        i128::from_be_bytes(h[..16].try_into().unwrap()).into_val(e),
        i128::from_be_bytes(h[16..].try_into().unwrap()).into_val(e),
    ]
}

fn flatten(e: &Env, value: Val, shape: &mut Vec<u32>, leaves: &mut Vec<Val>, depth: u32) {
    assert!(
        depth <= 16 && shape.len() < 2048 && leaves.len() < 256,
        "projection size"
    );
    if let Ok(items) = Vec::<Val>::try_from_val(e, &value) {
        shape.push_back(0);
        shape.push_back(items.len());
        for item in items {
            flatten(e, item, shape, leaves, depth + 1);
        }
    } else if let Ok(items) = Map::<Val, Val>::try_from_val(e, &value) {
        shape.push_back(1);
        shape.push_back(items.len());
        for (key, item) in items {
            flatten(e, key, shape, leaves, depth + 1);
            flatten(e, item, shape, leaves, depth + 1);
        }
    } else {
        // Semantic types: independent of host small-value/object representation.
        let tag = if u32::try_from_val(e, &value).is_ok() {
            2
        } else if i128::try_from_val(e, &value).is_ok() {
            3
        } else if Address::try_from_val(e, &value).is_ok() {
            4
        } else if Symbol::try_from_val(e, &value).is_ok() {
            5
        } else {
            6
        };
        shape.push_back(tag);
        if tag == 6 {
            leaves.append(&digest_limbs(e, value.to_xdr(e)));
        } else {
            leaves.push_back(value);
        }
    }
    assert!(
        shape.len() <= 2048 && leaves.len() <= 256,
        "projection size"
    );
}

#[cfg(test)]
mod tests;
