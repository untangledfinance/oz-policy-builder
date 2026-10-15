//! ScVal builders shared by the `check` and parity tests: the wire shape of a
//! predicate is written out here, independent of the contract's decoder.
#![allow(dead_code)]

extern crate alloc;

use alloc::vec::Vec as StdVec;
use soroban_sdk::xdr::{FromXdr as _, ScSymbol, ScVal, ScVec, ToXdr, VecM};
use soroban_sdk::{Address, Bytes, Env, IntoVal, Val};

pub fn sym(s: &str) -> ScVal {
    ScVal::Symbol(ScSymbol(s.as_bytes().to_vec().try_into().unwrap()))
}

pub fn vec(items: StdVec<ScVal>) -> ScVal {
    let v: VecM<ScVal> = items.try_into().expect("vec");
    ScVal::Vec(Some(ScVec(v)))
}

pub fn node(op: &str, rest: StdVec<ScVal>) -> ScVal {
    let mut items = alloc::vec![sym(op)];
    items.extend(rest);
    vec(items)
}

pub fn i128v(v: i128) -> ScVal {
    ScVal::I128(soroban_sdk::xdr::Int128Parts {
        hi: (v >> 64) as i64,
        lo: (v as u128 & u128::from(u64::MAX)) as u64,
    })
}

pub fn addr(env: &Env, a: &Address) -> ScVal {
    let v: Val = a.into_val(env);
    ScVal::from_xdr(env, &v.to_xdr(env)).unwrap()
}

/// The canonical XDR bytes a predicate is stored as.
pub fn xdr_bytes(env: &Env, v: &ScVal) -> Bytes {
    let val: Val = v.into_val(env);
    val.to_xdr(env)
}
