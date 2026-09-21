#![no_std]
//! Stateless, per-Prime batching. One job: run several calls in one
//! transaction, under one authorization from the Prime account.
//!
//! The request is handed over as it is, and the signature covers all of it:
//!
//!   args[0] = calls     -> call_path([0, n, "args", i])
//!   args[1] = grants
//!
//! GRANTS ARE DATA. Every context that will be offered to the policy is named
//! in that list, so this contract needs to know neither what enforces the
//! rules nor what its entrypoint is called. It authorises exactly the grants
//! it was given and not one more: a call that quietly raises another
//! requirement finds no grant left and the batch reverts. That list also
//! replaces the separate `prime_contexts` argument, because a nested
//! requirement is just another context to name.
use soroban_sdk::{
    auth::InvokerContractAuthEntry, contract, contractimpl, contracttype, vec, Address, Bytes, Env,
    IntoVal, Symbol, Val, Vec,
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
        policy: Address,
        calls: Vec<Call>,
        grants: Vec<InvokerContractAuthEntry>,
    ) -> Vec<Val> {
        let adapter = e.current_contract_address();
        assert_eq!(adapter, execution_address(&e, &prime), "wrong Prime");
        assert!(!calls.is_empty() && calls.len() <= 8, "batch size");
        // A venue call must never reach the account, the policy or this
        // contract - that is the self-administration route. A GRANT is the
        // opposite case: the policy is exactly what it should name, so only
        // the account and this contract are out of bounds there.
        let mut count = 0;
        for call in calls.iter() {
            assert!(
                call.target != prime && call.target != policy && call.target != adapter,
                "management target"
            );
            check_auths(&prime, &adapter, &call.executor_authorizations, 0, &mut count);
        }
        check_auths(&prime, &adapter, &grants, 0, &mut count);
        let args: Vec<Val> = vec![&e, calls.clone().into_val(&e), grants.clone().into_val(&e)];
        // The next auth frame must consume these grants; no intervening contract call.
        e.authorize_as_current_contract(grants);
        prime.require_auth_for_args(args);
        Vec::from_iter(
            &e,
            calls.iter().map(|call| {
                if !call.executor_authorizations.is_empty() {
                    e.authorize_as_current_contract(call.executor_authorizations);
                }
                e.invoke_contract::<Val>(&call.target, &call.function_name, call.args)
            }),
        )
    }
}

fn check_auths(
    prime: &Address,
    adapter: &Address,
    entries: &Vec<InvokerContractAuthEntry>,
    depth: u32,
    count: &mut u32,
) {
    assert!(depth <= 8, "authorization depth");
    for entry in entries {
        *count += 1;
        assert!(*count <= 32, "authorization count");
        let InvokerContractAuthEntry::Contract(call) = entry else {
            panic!("contract creation authorization");
        };
        assert!(
            &call.context.contract != prime && &call.context.contract != adapter,
            "management target"
        );
        check_auths(prime, adapter, &call.sub_invocations, depth + 1, count);
    }
}

#[cfg(test)]
mod tests;
