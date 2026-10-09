//! prime-session: one wallet signature -> a short-lived session key that acts as the wallet's session PDA, a member
//! of the Squads Smart Account's policies only (never a settings signer), so a session key can make the moves its
//! policy allows and can never vote as a seat. Stateless: the grant is re-checked on every move by Solana's ed25519
//! program (instruction introspection). A session ends at its time (at most 7 days), when its owner revokes that one
//! key, or when the account's 2-of-3 removes the PDA from the policy.
//!
//! The owner is an ed25519 key that signs plain text: Phantom's own key (`signMessage`), or a NEAR MPC key held for
//! MetaMask (its eth-implicit NEAR account) or Freighter (through prime-near-signer); the MPC signs the text bytes.
//! PDA = ["prime", owner, settings]: one per wallet per Smart Account, so a grant works in that account only.
//! The owner signs:
//!   "Prime session\nsigner: <PDA>\nsession key: <key>\nvalid until (unix time): <t>\ncluster: <c>"
//! Revoke = the same text with t = 0. It creates an empty account at [owner, settings, key] that this program owns;
//! a move must pass that address and is refused when the account exists. Only this program can assign it, so only the
//! owner's signature can create it.
//!
//! data: owner (32) | settings (32) | t i64 | sig_ix u8 | PDA bump u8 | Smart Account instruction data
//!   accounts: [0] ix sysvar, [1] session key (signs a move), [2] PDA, [3] Smart Account program (not checked; the
//!   System program for a revoke), [4] revoked marker, [5..] the Smart Account call's accounts (the rent payer first for a revoke)
use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, instruction::{AccountMeta, Instruction},
    program::invoke_signed, program_error::ProgramError, pubkey::Pubkey,
    sysvar::{clock::Clock, instructions, rent::Rent, Sysvar},
};

entrypoint!(process);

const ED25519: Pubkey = solana_program::pubkey!("Ed25519SigVerify111111111111111111111111111");
const SMART_ACCOUNT: Pubkey = solana_program::pubkey!("SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG");
const CLUSTER: &str = env!("PRIME_CLUSTER");

// Refusals: Custom(2) revoked, or a PDA or marker address that the data does not derive; Custom(4) expired or longer
// than 7 days; Custom(7) not signed by the owner over this text; MissingRequiredSignature if the session key did not
// sign. The inner call always goes to the Smart Account program (a constant, so no other target is possible).
fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (owner, settings, rest) = (&data[..32], &data[32..64], &data[64..]);
    let [ix_sysvar, signer, pda, _smart_account, marker, tail @ ..] = accounts else { return Err(ProgramError::NotEnoughAccountKeys) };
    let (key, until, sig_ix, bump, inner) = (*signer.key, i64::from_le_bytes(rest[..8].try_into().unwrap()), rest[8], rest[9], &rest[10..]);
    if !signer.is_signer && until != 0 { return Err(ProgramError::MissingRequiredSignature) }
    let text = format!("Prime session\nsigner: {}\nsession key: {}\nvalid until (unix time): {}\ncluster: {}", pda.key, key, until, CLUSTER);
    // The owner's signature over `text` must have been checked in this transaction by the ed25519 program
    // instruction at sig_ix, every field read from that instruction itself (offset index 0xffff).
    let pre = instructions::load_instruction_at_checked(sig_ix as usize, ix_sysvar)?; // also checks the sysvar id
    let (d, u) = (&pre.data, |i: usize| pre.data.get(i..i + 2).map(|b| u16::from_le_bytes([b[0], b[1]]) as usize));
    let own = pre.program_id == ED25519 && d.first() == Some(&1) && [u(4), u(8), u(14)].iter().all(|&i| i == Some(0xffff));
    let signed = (|| Some((d.get(u(6)?..u(6)? + 32)?, d.get(u(10)?..u(10)? + u(12)?)?)))();
    if !own || signed != Some((owner, text.as_bytes())) { return Err(ProgramError::Custom(7)) }
    // The marker is looked up under the verified owner and settings, and `settings` must be the one the text's PDA derives from.
    let (m, mb) = Pubkey::find_program_address(&[owner, settings, key.as_ref()], program_id);
    if m != *marker.key || marker.owner == program_id || Pubkey::create_program_address(&[b"prime", owner, settings, &[bump]], program_id)? != *pda.key { return Err(ProgramError::Custom(2)) }
    if until == 0 {
        let seeds: &[&[&[u8]]] = &[&[owner, settings, key.as_ref(), &[mb]]];
        let sys = |data: &[u8], a: Vec<AccountMeta>| invoke_signed(&Instruction::new_with_bytes(Pubkey::default(), data, a), accounts, seeds);
        sys(&[&[2, 0, 0, 0][..], &Rent::get()?.minimum_balance(0).to_le_bytes()].concat(), vec![AccountMeta::new(*tail[0].key, true), AccountMeta::new(m, false)])?;
        return sys(&[&[1, 0, 0, 0][..], program_id.as_ref()].concat(), vec![AccountMeta::new(m, true)]);
    }
    let now = Clock::get()?.unix_timestamp;
    if now > until || until > now + 7 * 86_400 { return Err(ProgramError::Custom(4)) }
    let metas = tail.iter().map(|a| AccountMeta { pubkey: *a.key, is_signer: a.key == pda.key || a.is_signer, is_writable: a.is_writable }).collect();
    invoke_signed(&Instruction { program_id: SMART_ACCOUNT, accounts: metas, data: inner.to_vec() }, accounts, &[&[b"prime", owner, settings, &[bump]]])
}
