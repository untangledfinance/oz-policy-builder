//! Execution documents and explicit scopes in the existing interpreter.
//! Ledger storage is NOT transient: the bound adapter MUST close on success;
//! any propagated failure rolls back begin. Never trust an unverified adapter.
use crate::dsl;
use soroban_sdk::{
    auth::{Context, InvokerContractAuthEntry},
    contracterror, contracttype,
    xdr::{FromXdr, ToXdr},
    Address, Bytes, BytesN, Env, IntoVal, Map, Symbol, TryFromVal, Val, Vec,
};

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
pub struct AuthRule {
    pub predicate: Bytes,
    pub children: Vec<AuthRule>,
}
#[contracttype]
#[derive(Clone)]
pub struct Step {
    pub predicate: Bytes,
    pub authorizations: Vec<AuthRule>,
}
#[contracttype]
#[derive(Clone)]
pub enum PathPart {
    Index(u32),
    Key(Symbol),
}
#[contracttype]
#[derive(Clone)]
pub struct Equality {
    pub left: Vec<PathPart>,
    pub right: Vec<PathPart>,
}
#[contracttype]
#[derive(Clone)]
pub struct Plan {
    pub steps: Vec<Step>,
    pub equalities: Vec<Equality>,
}
#[contracttype]
#[derive(Clone)]
pub struct Config {
    pub executor: Address,
    pub plans: Vec<Plan>,
}

#[contracttype]
#[derive(Clone)]
struct Scope {
    prime: Address,
    calls: Vec<Call>,
    approved: Option<BytesN<32>>,
    consumed: u32,
}
#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Error {
    Denied = 900,
    BadConfig = 901,
    ScopeExists = 902,
    NoScope = 903,
}
fn require(e: &Env, condition: bool) {
    if !condition {
        soroban_sdk::panic_with_error!(e, Error::Denied);
    }
}
fn key(e: &Env, executor: &Address) -> (Symbol, Address) {
    (Symbol::new(e, "exec_scope"), executor.clone())
}
pub fn active(e: &Env, executor: &Address) -> bool {
    e.storage().temporary().has(&key(e, executor))
}
pub fn begin(e: &Env, executor: Address, prime: Address, calls: Vec<Call>) {
    executor.require_auth();
    require(
        e,
        !calls.is_empty() && calls.len() <= 8 && calls.clone().to_xdr(e).len() <= 32768,
    );
    if active(e, &executor) {
        soroban_sdk::panic_with_error!(e, Error::ScopeExists);
    }
    e.storage().temporary().set(
        &key(e, &executor),
        &Scope {
            prime,
            calls,
            approved: None,
            consumed: 0,
        },
    );
}
pub fn end(e: &Env, executor: Address) {
    executor.require_auth();
    if !active(e, &executor) {
        soroban_sdk::panic_with_error!(e, Error::NoScope);
    }
    e.storage().temporary().remove(&key(e, &executor));
}

/// None means an ordinary legacy DSL document; malformed execution data fails.
pub fn decode(e: &Env, bytes: &Bytes) -> Option<Config> {
    if bytes.len() > dsl::MAX_PREDICATE_BYTES {
        soroban_sdk::panic_with_error!(e, Error::BadConfig);
    }
    let raw = Val::from_xdr(e, bytes).ok()?;
    let v = Vec::<Val>::try_from_val(e, &raw).ok()?;
    if v.is_empty() || Symbol::try_from_val(e, &v.get(0)?).ok()? != Symbol::new(e, "execution_v1") {
        return None;
    }
    if v.len() != 2 {
        soroban_sdk::panic_with_error!(e, Error::BadConfig);
    }
    Some(Config::try_from_val(e, &v.get(1).unwrap()).unwrap())
}
fn valid_predicate(e: &Env, bytes: &Bytes) {
    let node = dsl::decode_with_byte_cap(e, bytes).unwrap();
    require(
        e,
        dsl::has_selector_leaf(&node) && dsl::validate_scaled_ratios(&node).is_ok(),
    );
}
fn valid_auth(e: &Env, rules: &Vec<AuthRule>, depth: u32, count: &mut u32) {
    require(e, depth <= 4);
    for rule in rules {
        *count += 1;
        require(e, *count <= 32);
        valid_predicate(e, &rule.predicate);
        valid_auth(e, &rule.children, depth + 1, count);
    }
}
pub fn validate_config(e: &Env, cfg: &Config) {
    require(e, !cfg.plans.is_empty() && cfg.plans.len() <= 8);
    for plan in &cfg.plans {
        require(
            e,
            !plan.steps.is_empty() && plan.steps.len() <= 8 && plan.equalities.len() <= 32,
        );
        let mut count = 0;
        for step in &plan.steps {
            valid_predicate(e, &step.predicate);
            valid_auth(e, &step.authorizations, 0, &mut count);
        }
        for eq in &plan.equalities {
            require(
                e,
                !eq.left.is_empty()
                    && eq.left.len() <= 16
                    && !eq.right.is_empty()
                    && eq.right.len() <= 16,
            );
        }
    }
}
fn permit(e: &Env, predicate: &Bytes, target: Address, name: Symbol, args: Vec<Val>) -> bool {
    let node = dsl::decode_with_byte_cap(e, predicate).unwrap();
    dsl::evaluate(
        e,
        &node,
        &dsl::EvalContext {
            contract: target,
            fn_name: name,
            args,
        },
    ) == dsl::EvalDecision::Permit
}
fn reserved(e: &Env, target: &Address, prime: &Address, executor: &Address) -> bool {
    target == prime || target == executor || *target == e.current_contract_address()
}
fn match_auth(
    e: &Env,
    rules: &Vec<AuthRule>,
    entries: &Vec<InvokerContractAuthEntry>,
    prime: &Address,
    executor: &Address,
    depth: u32,
    count: &mut u32,
) -> bool {
    if rules.len() != entries.len() || depth > 4 {
        return false;
    }
    for (rule, entry) in rules.iter().zip(entries.iter()) {
        *count += 1;
        if *count > 32 {
            return false;
        }
        match entry {
            InvokerContractAuthEntry::Contract(c) => {
                if reserved(e, &c.context.contract, prime, executor)
                    || !permit(
                        e,
                        &rule.predicate,
                        c.context.contract,
                        c.context.fn_name,
                        c.context.args,
                    )
                    || !match_auth(
                        e,
                        &rule.children,
                        &c.sub_invocations,
                        prime,
                        executor,
                        depth + 1,
                        count,
                    )
                {
                    return false;
                }
            }
            _ => return false,
        }
    }
    true
}
fn select(e: &Env, mut value: Val, path: &Vec<PathPart>) -> Option<Val> {
    for part in path {
        value = match part {
            PathPart::Index(i) => Vec::<Val>::try_from_val(e, &value).ok()?.get(i)?,
            PathPart::Key(k) => Map::<Symbol, Val>::try_from_val(e, &value).ok()?.get(k)?,
        };
    }
    Some(value)
}
fn match_plan(
    e: &Env,
    plan: &Plan,
    calls: &Vec<Call>,
    prime: &Address,
    executor: &Address,
) -> bool {
    if plan.steps.len() != calls.len() {
        return false;
    }
    let mut count = 0;
    for (step, call) in plan.steps.iter().zip(calls.iter()) {
        if reserved(e, &call.target, prime, executor)
            || !permit(
                e,
                &step.predicate,
                call.target,
                call.function_name,
                call.args,
            )
            || !match_auth(
                e,
                &step.authorizations,
                &call.executor_authorizations,
                prime,
                executor,
                0,
                &mut count,
            )
        {
            return false;
        }
    }
    let root: Val = calls.into_val(e);
    for eq in &plan.equalities {
        match (select(e, root, &eq.left), select(e, root, &eq.right)) {
            (Some(a), Some(b)) if a.to_xdr(e) == b.to_xdr(e) => {}
            _ => return false,
        }
    }
    true
}
pub fn enforce(
    e: &Env,
    cfg: &Config,
    document: &Bytes,
    signer_hash: &BytesN<32>,
    prime: &Address,
    context: &Context,
) {
    let k = key(e, &cfg.executor);
    let mut scope: Scope = e
        .storage()
        .temporary()
        .get(&k)
        .unwrap_or_else(|| soroban_sdk::panic_with_error!(e, Error::NoScope));
    require(e, scope.prime == *prime);
    let mut bound = document.clone();
    bound.append(&signer_hash.to_xdr(e));
    let fingerprint: BytesN<32> = e.crypto().sha256(&bound).into();
    match context {
        Context::Contract(c) if c.contract == cfg.executor => {
            require(
                e,
                scope.approved.is_none()
                    && c.fn_name == Symbol::new(e, "execute")
                    && c.args.len() == 2,
            );
            require(
                e,
                Address::try_from_val(e, &c.args.get(0).unwrap()).unwrap() == *prime,
            );
            let calls = Vec::<Call>::try_from_val(e, &c.args.get(1).unwrap()).unwrap();
            require(e, calls.clone().to_xdr(e) == scope.calls.clone().to_xdr(e));
            require(
                e,
                cfg.plans
                    .iter()
                    .any(|p| match_plan(e, &p, &calls, prime, &cfg.executor)),
            );
            scope.approved = Some(fingerprint);
        }
        Context::Contract(c) => {
            require(e, scope.approved == Some(fingerprint));
            let mut matched = false;
            for (i, call) in scope.calls.iter().enumerate() {
                let bit = 1u32 << i;
                if scope.consumed & bit == 0
                    && call.target == c.contract
                    && call.function_name == c.fn_name
                    && call.args.to_xdr(e) == c.args.clone().to_xdr(e)
                {
                    scope.consumed |= bit;
                    matched = true;
                    break;
                }
            }
            require(e, matched);
        }
        _ => soroban_sdk::panic_with_error!(e, Error::Denied),
    }
    e.storage().temporary().set(&k, &scope);
}
