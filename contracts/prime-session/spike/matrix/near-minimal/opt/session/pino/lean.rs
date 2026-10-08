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
#![no_std]
use five8::encode_32;
use pinocchio::{
    account_info::AccountInfo, cpi::slice_invoke_signed, instruction::{AccountMeta, Instruction, Seed, Signer}, no_allocator, nostd_panic_handler, program_entrypoint,
    program_error::ProgramError, pubkey::{create_program_address, find_program_address, Pubkey}, sysvars::{clock::Clock, instructions::Instructions, rent::Rent, Sysvar}, ProgramResult,
};
use pinocchio_pubkey::pubkey;

program_entrypoint!(process);
no_allocator!();
nostd_panic_handler!();

const ED25519: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");
const SMART_ACCOUNT: Pubkey = pubkey!("SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG");
const CLUSTER: &str = env!("PRIME_CLUSTER");

// Refusals: Custom(2) revoked, or a PDA or marker address that the data does not derive; Custom(4) expired or longer
// than 7 days; Custom(7) not signed by the owner over this text; MissingRequiredSignature if the session key did not
// sign. The inner call always goes to the Smart Account program (a constant, so no other target is possible).
fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 74 { return Err(ProgramError::InvalidInstructionData) }
    let (owner, settings, rest) = (&data[..32], &data[32..64], &data[64..]);
    let [ix_sysvar, signer, pda, _smart_account, marker, tail @ ..] = accounts else { return Err(ProgramError::NotEnoughAccountKeys) };
    let (key, until, sig_ix, bump, inner) = (*signer.key(), i64::from_le_bytes(rest[..8].try_into().unwrap()), rest[8], [rest[9]], &rest[10..]);
    if !signer.is_signer() && until != 0 { return Err(ProgramError::MissingRequiredSignature) }
    let (mut text, mut n, mut num, mut b58) = ([0u8; 256], 0, [0u8; 20], ([0u8; 44], [0u8; 44]));
    let (la, lb) = (encode_32(pda.key(), &mut b58.0) as usize, encode_32(&key, &mut b58.1) as usize);
    let mut i = 20;
    let mut u = until.unsigned_abs();
    while { i -= 1; num[i] = b'0' + (u % 10) as u8; u /= 10; u != 0 } {}
    if until < 0 { i -= 1; num[i] = b'-' }
    for x in [&b"Prime session\nsigner: "[..], &b58.0[..la], b"\nsession key: ", &b58.1[..lb], b"\nvalid until (unix time): ", &num[i..], b"\ncluster: ", CLUSTER.as_bytes()] {
        text[n..n + x.len()].copy_from_slice(x);
        n += x.len();
    }
    // The owner's signature over `text` must have been checked in this transaction by the ed25519 program
    // instruction at sig_ix, every field read from that instruction itself (offset index 0xffff).
    let ixs = Instructions::try_from(ix_sysvar)?; // also checks the sysvar id
    let pre = ixs.load_instruction_at(sig_ix as usize).map_err(|_| ProgramError::InvalidArgument)?;
    let d = pre.get_instruction_data();
    let u = |i: usize| d.get(i..i + 2).map(|b| u16::from_le_bytes([b[0], b[1]]) as usize);
    let own = pre.get_program_id() == &ED25519 && d.first() == Some(&1) && [u(4), u(8), u(14)].iter().all(|&i| i == Some(0xffff));
    let signed = (|| Some((d.get(u(6)?..u(6)? + 32)?, d.get(u(10)?..u(10)? + u(12)?)?)))();
    if !own || signed != Some((owner, &text[..n])) { return Err(ProgramError::Custom(7)) }
    // The marker is looked up under the verified owner and settings, and `settings` must be the one the text's PDA derives from.
    let (m, mb) = find_program_address(&[owner, settings, key.as_ref()], program_id);
    if m != *marker.key() || marker.owner() == program_id || create_program_address(&[b"prime", owner, settings, &bump], program_id).map_err(|_| ProgramError::InvalidSeeds)? != *pda.key() { return Err(ProgramError::Custom(2)) }
    if until == 0 {
        let (payer, mb) = (tail.first().ok_or(ProgramError::NotEnoughAccountKeys)?, [mb]);
        let seeds = [Seed::from(owner), Seed::from(settings), Seed::from(key.as_ref()), Seed::from(&mb)];
        let (mut x, mut y) = ([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        x[4..].copy_from_slice(&Rent::get()?.minimum_balance(0).to_le_bytes());
        y[4..].copy_from_slice(program_id);
        slice_invoke_signed(&Instruction { program_id: &[0; 32], data: &x, accounts: &[AccountMeta::writable_signer(payer.key()), AccountMeta::writable(marker.key())] }, &[payer, marker], &[Signer::from(&seeds)])?;
        return slice_invoke_signed(&Instruction { program_id: &[0; 32], data: &y, accounts: &[AccountMeta::writable_signer(marker.key())] }, &[marker], &[Signer::from(&seeds)]);
    }
    let now = Clock::get()?.unix_timestamp;
    if now > until || until > now + 7 * 86_400 { return Err(ProgramError::Custom(4)) }
    let metas: [AccountMeta; 64] = core::array::from_fn(|i| tail.get(i).map_or(AccountMeta::readonly(&[0; 32]), |a| AccountMeta::new(a.key(), a.is_writable(), a.key() == pda.key() || a.is_signer())));
    let infos: [&AccountInfo; 64] = core::array::from_fn(|i| tail.get(i).unwrap_or(ix_sysvar));
    let seeds = [Seed::from(&b"prime"[..]), Seed::from(owner), Seed::from(settings), Seed::from(&bump)];
    slice_invoke_signed(&Instruction { program_id: &SMART_ACCOUNT, accounts: metas.get(..tail.len()).ok_or(ProgramError::InvalidArgument)?, data: inner }, &infos[..tail.len()], &[Signer::from(&seeds)])
}
