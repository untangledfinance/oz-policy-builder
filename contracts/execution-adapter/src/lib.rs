#![no_std]
//! Stateless, per-Prime batching. One job: run several calls in one
//! transaction, under one authorization from the Prime account.
//!
//! Until grammar 6 this contract also had to FLATTEN the request into a
//! synthetic argument list, because the interpreter's selectors could only
//! address one call. That projection was 38% of the file and it put
//! policy-shaped logic outside the contract that enforces policy. Grammar 6
//! addresses a batch directly, so the request is handed over as it is:
//!
//!   args[0] = calls            -> call_path([0, n, "args", i])
//!   args[1] = prime_contexts
//!   args[2] = policy
//!   args[3] = policy_fn
//!
//! The policy contract is named by address AND by function: this contract
//! does not know what enforces the rules, only that each context has to be
//! offered to something before its call runs.
//!
//! Everything in the request is committed by that one signature, so no leg of
//! the batch can be altered after the agent signed it.
use soroban_sdk::{
    auth::{Context, ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractimpl, contracttype, vec, Address, Bytes, Env, IntoVal, Symbol, Val, Vec,
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
        policy_fn: Symbol,
        calls: Vec<Call>,
        prime_contexts: Vec<ContractContext>,
    ) -> Vec<Val> {
        let adapter = e.current_contract_address();
        assert_eq!(adapter, execution_address(&e, &prime), "wrong Prime");
        assert!(!calls.is_empty() && calls.len() <= 8, "batch size");
        assert!(prime_contexts.len() <= 16, "context count");
        let forbidden = [prime.clone(), policy.clone(), adapter.clone()];
        let mut auth_count = 0;
        let mut contexts = Vec::new(&e);
        for call in calls.iter() {
            venue_target(&forbidden, &call.target);
            check_auths(
                &forbidden,
                &call.executor_authorizations,
                0,
                &mut auth_count,
            );
            contexts.push_back(ContractContext {
                contract: call.target,
                fn_name: call.function_name,
                args: call.args,
            });
        }
        for context in prime_contexts.iter() {
            venue_target(&forbidden, &context.contract);
            contexts.push_back(context);
        }
        let args: Vec<Val> = vec![
            &e,
            calls.clone().into_val(&e),
            prime_contexts.clone().into_val(&e),
            policy.clone().into_val(&e),
            policy_fn.clone().into_val(&e),
        ];
        contexts.push_front(ContractContext {
            contract: adapter,
            fn_name: Symbol::new(&e, "execute"),
            args: args.clone(),
        });
        let grants = Vec::from_iter(
            &e,
            contexts.iter().map(|context| {
                InvokerContractAuthEntry::Contract(SubContractInvocation {
                    context: ContractContext {
                        contract: policy.clone(),
                        fn_name: policy_fn.clone(),
                        args: (prime.clone(), Context::Contract(context)).into_val(&e),
                    },
                    sub_invocations: Vec::new(&e),
                })
            }),
        );
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

fn venue_target(forbidden: &[Address; 3], target: &Address) {
    assert!(!forbidden.contains(target), "management target");
}

fn check_auths(
    forbidden: &[Address; 3],
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
        venue_target(forbidden, &call.context.contract);
        check_auths(forbidden, &call.sub_invocations, depth + 1, count);
    }
}

#[cfg(test)]
mod tests;
