//! prime-session: one wallet signature -> a short-lived session key that acts as the wallet's session PDA, a member
//! of the Squads Smart Account's policies only (never a settings signer), so a session key can make the moves its
//! policy allows and can never vote as a seat. Stateless: the grant is re-checked on every move by Solana's ed25519
//! program (instruction introspection). No per-session revoke: a session ends at its time (at most 7 days), or
//! earlier when the account's 2-of-3 removes the PDA from the policy.
//!
//! The owner is an ed25519 key that signs plain text: Phantom's own key (`signMessage`), or a NEAR MPC key held for
//! MetaMask (its eth-implicit NEAR account) or Freighter (through prime-near-signer); the MPC signs the text bytes.
//! PDA = ["prime", owner, settings]: one per wallet per Smart Account, so a grant works in that account only.
//! The owner signs:
//!   "Prime session\nsigner: <PDA>\nsession key: <key>\nvalid until (unix time): <t>\ncluster: <c>\nprogram: <id>"
//!
//! data: owner (32) | settings (32) | t i64 | sig_ix u8 | Smart Account instruction data
//!   accounts: [0] ix sysvar, [1] session key (signer), [2] PDA, [3] Smart Account program, [4..] its accounts
use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, instruction::{AccountMeta, Instruction},
    program::invoke_signed, program_error::ProgramError, pubkey::Pubkey,
    sysvar::{clock::Clock, instructions, Sysvar},
};

entrypoint!(process);

const ED25519: Pubkey = solana_program::pubkey!("Ed25519SigVerify111111111111111111111111111");
const SMART_ACCOUNT: Pubkey = solana_program::pubkey!("SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG");
const CLUSTER: &str = match option_env!("PRIME_CLUSTER") { Some(c) => c, None => "localnet" };

// Refusals: Custom(4) expired or longer than 7 days, Custom(7) not signed by the owner over this text, Custom(10)
// a call to anything but the Smart Account program; MissingRequiredSignature if the session key did not sign. A wrong
// PDA needs no check here: the grant text names the PDA, and the runtime refuses the inner call if it marks as signer
// an address that invoke_signed's seeds do not derive.
fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 73 { return Err(ProgramError::InvalidInstructionData) }
    let (owner, settings, rest) = (&data[..32], &data[32..64], &data[64..]);
    let [ix_sysvar, signer, pda, next, tail @ ..] = accounts else { return Err(ProgramError::NotEnoughAccountKeys) };
    if !signer.is_signer { return Err(ProgramError::MissingRequiredSignature) }
    let bump = Pubkey::find_program_address(&[b"prime", owner, settings], program_id).1;
    let (key, until, sig_ix, inner) = (*signer.key, i64::from_le_bytes(rest[..8].try_into().unwrap()), rest[8], &rest[9..]);
    let text = format!("Prime session\nsigner: {}\nsession key: {}\nvalid until (unix time): {}\ncluster: {}\nprogram: {}", pda.key, key, until, CLUSTER, program_id);
    // The owner's signature over `text` must have been checked in this transaction by the ed25519 program
    // instruction at sig_ix, every field read from that instruction itself (offset index 0xffff).
    let pre = instructions::load_instruction_at_checked(sig_ix as usize, ix_sysvar)?; // also checks the sysvar id
    let (d, u) = (&pre.data, |i: usize| pre.data.get(i..i + 2).map(|b| u16::from_le_bytes([b[0], b[1]]) as usize));
    let own = pre.program_id == ED25519 && d.first() == Some(&1) && [u(4), u(8), u(14)].iter().all(|&i| i == Some(0xffff));
    let signed = (|| Some((d.get(u(6)?..u(6)? + 32)?, d.get(u(10)?..u(10)? + u(12)?)?)))();
    if !own || signed != Some((owner, text.as_bytes())) { return Err(ProgramError::Custom(7)) }
    let now = Clock::get()?.unix_timestamp;
    if now > until || until > now + 7 * 86_400 { return Err(ProgramError::Custom(4)) }
    if *next.key != SMART_ACCOUNT { return Err(ProgramError::Custom(10)) }
    let metas = tail.iter().map(|a| AccountMeta { pubkey: *a.key, is_signer: a.key == pda.key || a.is_signer, is_writable: a.is_writable }).collect();
    invoke_signed(&Instruction { program_id: SMART_ACCOUNT, accounts: metas, data: inner.to_vec() }, accounts, &[&[b"prime", owner, settings, &[bump]]])
}
