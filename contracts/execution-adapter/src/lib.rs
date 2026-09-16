#![no_std]
use soroban_sdk::{
    auth::InvokerContractAuthEntry, contract, contractimpl, contracttype, Address, Env, IntoVal,
    Symbol, Val, Vec,
};
#[contracttype]
#[derive(Clone)]
pub struct Call {
    pub target: Address,
    pub function_name: Symbol,
    pub args: Vec<Val>,
    pub executor_authorizations: Vec<InvokerContractAuthEntry>,
}
#[contract]
pub struct ExecutionAdapter;
#[contractimpl]
impl ExecutionAdapter {
    pub fn __constructor(e: Env, prime: Address, interpreter: Address) {
        e.storage()
            .instance()
            .set(&Symbol::new(&e, "interpreter"), &interpreter);
        e.storage()
            .instance()
            .set(&Symbol::new(&e, "prime"), &prime);
    }
    pub fn configuration(e: Env) -> (Address, Address) {
        (
            e.storage()
                .instance()
                .get(&Symbol::new(&e, "prime"))
                .unwrap(),
            e.storage()
                .instance()
                .get(&Symbol::new(&e, "interpreter"))
                .unwrap(),
        )
    }
    pub fn execute(e: Env, prime: Address, calls: Vec<Call>) -> Vec<Val> {
        assert!(!calls.is_empty() && calls.len() <= 8, "batch size");
        let bound: Address = e
            .storage()
            .instance()
            .get(&Symbol::new(&e, "prime"))
            .unwrap();
        assert!(prime == bound, "wrong Prime account");
        let interpreter: Address = e
            .storage()
            .instance()
            .get(&Symbol::new(&e, "interpreter"))
            .unwrap();
        let executor = e.current_contract_address();
        e.invoke_contract::<()>(
            &interpreter,
            &Symbol::new(&e, "begin_execution"),
            (&executor, &prime, &calls).into_val(&e),
        );
        prime.require_auth();
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
        e.invoke_contract::<()>(
            &interpreter,
            &Symbol::new(&e, "end_execution"),
            (&executor,).into_val(&e),
        );
        results
    }
}
#[cfg(test)]
mod tests;
