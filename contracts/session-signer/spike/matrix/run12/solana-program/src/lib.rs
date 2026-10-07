//! prime-session (spike): one wallet signature -> a short-lived session key that acts as a PDA signer.
//!
//! The PDA is ["prime", kind, owner] (kind 0 = EVM address 20 B, 1 = Stellar ed25519, 2 = Solana ed25519).
//! The owner grants a session by signing readable text, checked by Solana's own signature programs
//! (instruction introspection; the program never verifies a signature itself):
//!   text  = "Prime session\nsigner: <PDA>\nsession key: <key>\nvalid until: <unix seconds>"
//!   EVM     (MetaMask personal_sign): secp256k1 program, message = "\x19Ethereum Signed Message:\n" + len + text
//!   Stellar (Freighter SEP-53):       ed25519 program,   message = sha256("Stellar Signed Message:\n" + text)
//!   Solana  (Phantom signMessage):    ed25519 program,   message = text
//! `execute` then runs one instruction on `target` with the PDA as a signer, if the session key signed
//! this transaction and the grant has not expired.
//!
//! Instruction data: kind u8 | owner (20 or 32 B) | valid_until i64 LE | sig_ix u8 | target ix data.
//! Accounts: [0] instructions sysvar, [1] session key (signer), [2] PDA, [3] target program, [4..] target accounts.
use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, hash::hashv, instruction::{AccountMeta, Instruction},
    msg, program::invoke_signed, program_error::ProgramError, pubkey::Pubkey, sysvar::{clock::Clock, instructions, Sysvar},
};

entrypoint!(process);

const ED25519: Pubkey = solana_program::pubkey!("Ed25519SigVerify111111111111111111111111111");
const SECP256K1: Pubkey = solana_program::pubkey!("KeccakSecp256k11111111111111111111111111111");

fn err(code: u32, m: &str) -> ProgramError {
    msg!("prime-session: {}", m);
    ProgramError::Custom(code)
}

fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (&kind, rest) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    let olen = match kind { 0 => 20, 1 | 2 => 32, _ => return Err(ProgramError::InvalidInstructionData) };
    if rest.len() < olen + 9 { return Err(ProgramError::InvalidInstructionData) }
    let owner = &rest[..olen];
    let valid_until = i64::from_le_bytes(rest[olen..olen + 8].try_into().unwrap());
    let sig_ix = rest[olen + 8] as usize;
    let inner = &rest[olen + 9..];

    let [ix_sysvar, session, pda, target, tail @ ..] = accounts else { return Err(ProgramError::NotEnoughAccountKeys) };
    if *ix_sysvar.key != instructions::ID { return Err(err(1, "not the instructions sysvar")) }
    if !session.is_signer { return Err(err(2, "session key did not sign")) }
    let (expected, bump) = Pubkey::find_program_address(&[b"prime", &[kind], owner], program_id);
    if *pda.key != expected { return Err(err(3, "wrong PDA for this owner")) }
    let now = Clock::get()?.unix_timestamp;
    if now > valid_until || valid_until > now + 7 * 86_400 { return Err(err(4, "expired or longer than 7 days")) }

    // The grant text, rebuilt here; the signature program must have checked the owner's signature over it.
    let text = format!("Prime session\nsigner: {}\nsession key: {}\nvalid until: {}", pda.key, session.key, valid_until);
    let pre = instructions::load_instruction_at_checked(sig_ix, ix_sysvar)?;
    match kind {
        0 => {
            if pre.program_id != SECP256K1 { return Err(err(5, "grant not checked by the secp256k1 program")) }
            let mut m = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
            m.extend_from_slice(text.as_bytes());
            let (addr, msg_bytes) = secp_entry(&pre.data, sig_ix).ok_or_else(|| err(6, "bad secp256k1 instruction"))?;
            if addr != owner || msg_bytes != m.as_slice() { return Err(err(7, "grant not signed by the owner over this text")) }
        }
        _ => {
            if pre.program_id != ED25519 { return Err(err(5, "grant not checked by the ed25519 program")) }
            let m: Vec<u8> = if kind == 1 { hashv(&[b"Stellar Signed Message:\n", text.as_bytes()]).to_bytes().to_vec() } else { text.into_bytes() };
            let (pk, msg_bytes) = ed_entry(&pre.data).ok_or_else(|| err(6, "bad ed25519 instruction"))?;
            if pk != owner || msg_bytes != m.as_slice() { return Err(err(7, "grant not signed by the owner over this text")) }
        }
    }

    // Run the target instruction with the PDA signing.
    let metas: Vec<AccountMeta> = tail.iter().map(|a| AccountMeta { pubkey: *a.key, is_signer: a.key == pda.key || a.is_signer, is_writable: a.is_writable }).collect();
    let mut infos: Vec<AccountInfo> = tail.to_vec();
    infos.push(pda.clone());
    invoke_signed(&Instruction { program_id: *target.key, accounts: metas, data: inner.to_vec() }, &infos, &[&[b"prime", &[kind], owner, &[bump]]])
}

/// The single signature in an ed25519 program instruction whose data are all in that instruction.
fn ed_entry(d: &[u8]) -> Option<(&[u8], &[u8])> {
    if d.len() < 16 || d[0] != 1 { return None }
    let u = |i: usize| u16::from_le_bytes([d[i], d[i + 1]]) as usize;
    let (pk_off, pk_ix, m_off, m_len, m_ix, s_ix) = (u(6), u(8), u(10), u(12), u(14), u(4));
    if pk_ix != 0xffff || m_ix != 0xffff || s_ix != 0xffff { return None }
    Some((d.get(pk_off..pk_off + 32)?, d.get(m_off..m_off + m_len)?))
}

/// The single signature in a secp256k1 program instruction whose data are all in that instruction.
fn secp_entry(d: &[u8], own_index: usize) -> Option<(&[u8], &[u8])> {
    if d.len() < 12 || d[0] != 1 { return None }
    let u = |i: usize| u16::from_le_bytes([d[i], d[i + 1]]) as usize;
    // offsets: sig u16, sig_ix u8, eth u16, eth_ix u8, msg u16, msg_len u16, msg_ix u8
    let (sig_ix, eth_off, eth_ix, m_off, m_len, m_ix) = (d[3] as usize, u(4), d[6] as usize, u(7), u(9), d[11] as usize);
    // Solana's secp256k1 program reads each field from the instruction at that index: all three must be the
    // signature instruction itself, so the bytes checked here are the bytes it verified.
    if sig_ix != own_index || eth_ix != own_index || m_ix != own_index { return None }
    Some((d.get(eth_off..eth_off + 20)?, d.get(m_off..m_off + m_len)?))
}
