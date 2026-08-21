//! Master-authorisation check.
//!
//! Pattern: call `require_auth` on every member of the stored master set.
//! The smart_account's `__check_auth` then authorises them in one batched
//! call. Soroban requires every `require_auth` in the batch to be satisfied
//! for the tx to succeed; this is intentional - any unauthorised addition
//! to the rule's signers (the security finding's attack vector) causes
//! `__check_auth` to deny, the tx reverts, and the agent's re-install is
//! rejected.

use soroban_sdk::{Env, Vec};

use crate::types::Signer;

/// Call `require_auth` on every signer in `master_set`. If any one is not
/// authorised, Soroban reverts the tx before this returns.
///
/// An EMPTY set is refused rather than treated as satisfied. Iterating an
/// empty set calls `require_auth` zero times, which is not "authorised by
/// nobody" - it is no authorisation at all, and it let anyone re-install an
/// arbitrary predicate on such a rule. OpenZeppelin permits a context rule
/// with zero signers as long as it carries at least one policy
/// (`smart_account/storage.rs`: `signer_ids.is_empty() && policy_ids.is_empty()`),
/// so this is reachable, not hypothetical. The guard lives here so no caller
/// can obtain a silently no-op check.
pub fn require_master(e: &Env, master_set: &Vec<Signer>) {
    if master_set.is_empty() {
        crate::storage::deny(e, crate::storage::PolicyError::EmptySignerSet);
    }
    for signer in master_set.iter() {
        signer.address().require_auth();
    }
}

/// Compare two signer sets element-by-element.
pub fn signer_sets_equal(a: &Vec<Signer>, b: &Vec<Signer>) -> bool {
    a.len() == b.len() && a.iter().zip(b.iter()).all(|(x, y)| signer_eq(&x, &y))
}

fn signer_eq(a: &Signer, b: &Signer) -> bool {
    match (a, b) {
        (Signer::Delegated(x), Signer::Delegated(y)) => x == y,
        (Signer::External(x, kx), Signer::External(y, ky)) => x == y && kx == ky,
        _ => false,
    }
}
