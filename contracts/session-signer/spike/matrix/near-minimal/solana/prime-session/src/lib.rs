//! prime-session: one wallet signature -> a short-lived session key that acts as the wallet's session PDA, a member
//! of the Squads Smart Account's policies only (never a settings signer), so a session key can make the moves its
//! policy allows and can never vote as a seat. Stateless: the grant is re-checked on every move by Solana's ed25519
//! program (instruction introspection). No per-session revoke: a session ends at its time (at most 7 days), or
//! earlier when the account's 2-of-3 removes the PDA from the policy.
//!
//! The owner is an ed25519 key that signs plain text: Phantom's own key (`signMessage`), or the NEAR MPC key of a
//! MetaMask / Freighter NEAR account (the MPC signs the text bytes).
//! PDA = ["prime", owner]. The owner signs:
//!   "Prime session\nsigner: <PDA>\nsession key: <key>\nvalid until (unix time): <t>\ncluster: <c>\nprogram: <id>"
//!
//! execute: 0 | owner (32) | t i64 | sig_ix u8 | Smart Account instruction data
//!   accounts: [0] ix sysvar, [1] session key (signer), [2] PDA, [3] Smart Account program, [4..] its accounts
use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, instruction::{AccountMeta, Instruction}, msg,
    program::invoke_signed, program_error::ProgramError, pubkey::Pubkey,
    sysvar::{clock::Clock, instructions, Sysvar},
};

entrypoint!(process);

const ED25519: Pubkey = solana_program::pubkey!("Ed25519SigVerify111111111111111111111111111");
const SMART_ACCOUNT: Pubkey = solana_program::pubkey!("SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG");
const CLUSTER: &str = match option_env!("PRIME_CLUSTER") { Some(c) => c, None => "localnet" };

fn err(code: u32, m: &str) -> ProgramError {
    msg!("prime-session: {}", m);
    ProgramError::Custom(code)
}

fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let bad = ProgramError::InvalidInstructionData;
    if data.len() < 42 { return Err(bad) }
    let (op, owner, rest) = (data[0], &data[1..33], &data[33..]);
    let [ix_sysvar, signer, pda, next, tail @ ..] = accounts else { return Err(ProgramError::NotEnoughAccountKeys) };
    if !signer.is_signer { return Err(err(2, "session key / payer did not sign")) }
    let (expected, bump) = Pubkey::find_program_address(&[b"prime", owner], program_id);
    if *pda.key != expected { return Err(err(3, "wrong PDA for this owner")) }
    if op != 0 { return Err(bad) }
    let (key, until, sig_ix, inner) = (*signer.key, i64::from_le_bytes(rest[..8].try_into().unwrap()), rest[8], &rest[9..]);
    let text = format!("Prime session\nsigner: {}\nsession key: {}\nvalid until (unix time): {}\ncluster: {}\nprogram: {}", pda.key, key, until, CLUSTER, program_id);
    // The owner's signature over `text` must have been checked in this transaction by the ed25519 program
    // instruction at sig_ix, every field read from that instruction itself (offset index 0xffff).
    let pre = instructions::load_instruction_at_checked(sig_ix as usize, ix_sysvar)?; // also checks the sysvar id
    let (d, u) = (&pre.data, |i: usize| pre.data.get(i..i + 2).map(|b| u16::from_le_bytes([b[0], b[1]]) as usize));
    let own = pre.program_id == ED25519 && d.first() == Some(&1) && [u(4), u(8), u(14)].iter().all(|&i| i == Some(0xffff));
    let signed = (|| Some((d.get(u(6)?..u(6)? + 32)?, d.get(u(10)?..u(10)? + u(12)?)?)))();
    if !own || signed != Some((owner, text.as_bytes())) { return Err(err(7, "not signed by the owner over this text")) }
    let now = Clock::get()?.unix_timestamp;
    if now > until || until > now + 7 * 86_400 { return Err(err(4, "expired or longer than 7 days")) }
    if *next.key != SMART_ACCOUNT { return Err(err(10, "sessions may only call the Smart Account program")) }
    let metas = tail.iter().map(|a| AccountMeta { pubkey: *a.key, is_signer: a.key == pda.key || a.is_signer, is_writable: a.is_writable }).collect();
    let mut infos = tail.to_vec();
    infos.push(pda.clone());
    invoke_signed(&Instruction { program_id: SMART_ACCOUNT, accounts: metas, data: inner.to_vec() }, &infos, &[&[b"prime", owner, &[bump]]])
}
