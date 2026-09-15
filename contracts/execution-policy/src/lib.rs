#![no_std]
extern crate alloc;
#[path = "../../policy-interpreter/src/dsl.rs"]
pub mod dsl;
#[path = "../../policy-interpreter/src/types.rs"]
pub mod types;
use soroban_sdk::{
    auth::{Context, InvokerContractAuthEntry},
    contract, contracterror, contractimpl, contracttype,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, Symbol, TryFromVal, Val, Vec,
};
use types::{ContextRule, ContextRuleType, Signer};
#[contracttype]
#[derive(Clone)]
pub struct Call {
    pub target: Address,
    pub function_name: Symbol,
    pub args: Vec<Val>,
    pub executor_authorizations: Vec<InvokerContractAuthEntry>,
}
#[contracttype]
#[derive(Clone)]
pub struct Config {
    pub executor: Address,
    pub call_predicate: Bytes,
    pub auth_predicate: Bytes,
    pub max_calls: u32,
}
#[contracttype]
#[derive(Clone)]
struct Stored {
    config: Config,
    signer_hash: BytesN<32>,
}
#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Error {
    Denied = 900,
    BadConfig = 901,
    AlreadyInstalled = 902,
    Missing = 903,
}

// Every top-level call and EVERY executor-authorization node is inspected.
// No protocol-specific branches. Predicates are installed by the account.
pub fn validate_batch(
    e: &Env,
    _prime: &Address,
    calls: &Vec<Call>,
    cfg: &Config,
) -> Result<(), Error> {
    if calls.is_empty() || calls.len() > cfg.max_calls || cfg.max_calls > 8 {
        return Err(Error::Denied);
    }
    let call_node =
        dsl::decode_with_byte_cap(e, &cfg.call_predicate).map_err(|_| Error::BadConfig)?;
    let auth_node =
        dsl::decode_with_byte_cap(e, &cfg.auth_predicate).map_err(|_| Error::BadConfig)?;
    let mut count = 0;
    for c in calls {
        permit(e, &call_node, c.target, c.function_name, c.args)?;
        for a in c.executor_authorizations {
            check_auth(e, &auth_node, a, 0, &mut count)?;
        }
    }
    Ok(())
}
fn permit(
    e: &Env,
    node: &dsl::Node,
    target: Address,
    name: Symbol,
    args: Vec<Val>,
) -> Result<(), Error> {
    if dsl::evaluate(
        e,
        node,
        &dsl::EvalContext {
            contract: target,
            fn_name: name,
            args,
        },
    ) == dsl::EvalDecision::Permit
    {
        Ok(())
    } else {
        Err(Error::Denied)
    }
}
fn check_auth(
    e: &Env,
    node: &dsl::Node,
    entry: InvokerContractAuthEntry,
    depth: u32,
    count: &mut u32,
) -> Result<(), Error> {
    *count += 1;
    if depth > 4 || *count > 32 {
        return Err(Error::Denied);
    }
    match entry {
        InvokerContractAuthEntry::Contract(c) => {
            permit(
                e,
                node,
                c.context.contract,
                c.context.fn_name,
                c.context.args,
            )?;
            for child in c.sub_invocations {
                check_auth(e, node, child, depth + 1, count)?;
            }
            Ok(())
        }
        _ => Err(Error::Denied),
    }
}

#[contract]
pub struct ExecutionPolicy;
#[contractimpl]
impl ExecutionPolicy {
    pub fn install(
        e: Env,
        install_params: Config,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();
        if install_params.max_calls == 0
            || install_params.max_calls > 8
            || !matches!(context_rule.context_type, ContextRuleType::CallContract(_))
        {
            soroban_sdk::panic_with_error!(&e, Error::BadConfig);
        }
        dsl::decode_with_byte_cap(&e, &install_params.call_predicate).unwrap();
        dsl::decode_with_byte_cap(&e, &install_params.auth_predicate).unwrap();
        let key = (smart_account, context_rule.id);
        if e.storage().persistent().has(&key) {
            soroban_sdk::panic_with_error!(&e, Error::AlreadyInstalled);
        }
        let signer_hash = e.crypto().sha256(&context_rule.signers.to_xdr(&e)).into();
        e.storage().persistent().set(
            &key,
            &Stored {
                config: install_params,
                signer_hash,
            },
        );
    }
    pub fn enforce(
        e: Env,
        context: Context,
        authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();
        assert!(!authenticated_signers.is_empty(), "no signer");
        let key = (smart_account.clone(), context_rule.id);
        let stored: Stored = e.storage().persistent().get(&key).unwrap();
        let hash: BytesN<32> = e.crypto().sha256(&context_rule.signers.to_xdr(&e)).into();
        assert!(hash == stored.signer_hash, "changed signers");
        match context {
            Context::Contract(c) if c.contract == stored.config.executor => {
                assert!(
                    c.fn_name == Symbol::new(&e, "execute") && c.args.len() == 2,
                    "bad entry"
                );
                assert!(
                    Address::try_from_val(&e, &c.args.get(0).unwrap()).unwrap() == smart_account,
                    "wrong prime"
                );
                let calls = Vec::<Call>::try_from_val(&e, &c.args.get(1).unwrap()).unwrap();
                if let Err(err) = validate_batch(&e, &smart_account, &calls, &stored.config) {
                    soroban_sdk::panic_with_error!(&e, err);
                }
            }
            Context::Contract(c) => {
                let node = dsl::decode_with_byte_cap(&e, &stored.config.call_predicate).unwrap();
                if let Err(err) = permit(&e, &node, c.contract, c.fn_name, c.args) {
                    soroban_sdk::panic_with_error!(&e, err);
                }
            }
            _ => panic!("noncall"),
        }
    }
    pub fn uninstall(_e: Env, _context_rule: ContextRule, smart_account: Address) {
        smart_account.require_auth();
    }
}
#[cfg(test)]
mod tests;
