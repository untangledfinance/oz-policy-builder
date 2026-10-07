//! prime-session v2 (spike): one wallet signature -> a short-lived session key that acts as a PDA signer,
//! with the three fixes from the run 12 review:
//!   - the grant text names the cluster (compile-time PRIME_CLUSTER) and this program, so a grant cannot be
//!     replayed on another cluster or another deployment;
//!   - the owner can revoke a session key (a marker account ["revoked", pda, key] that `execute` refuses);
//!   - `execute` may only call the Squads Smart Account program.
//!
//! PDA = ["prime", kind, owner] (kind 0 = EVM address 20 B, 1 = Stellar ed25519, 2 = Solana ed25519).
//! Texts the wallet signs (checked by Solana's ed25519 / secp256k1 programs through instruction introspection):
//!   grant:  "Prime session\nsigner: <PDA>\nsession key: <key>\nvalid until: <unix>\ncluster: <c>\nprogram: <id>"
//!   revoke: "Prime revoke\nsigner: <PDA>\nsession key: <key>\ncluster: <c>\nprogram: <id>"
//!   EVM: personal_sign prefix; Stellar: sha256 of the SEP-53 prefix + text; Solana: the text itself.
//!
//! execute: 0 | kind | owner | valid_until i64 | sig_ix u8 | inner data
//!   accounts: [0] ix sysvar, [1] session key (signer), [2] PDA, [3] revocation marker, [4] target, [5..] target accounts
//! revoke:  1 | kind | owner | sig_ix u8 | session key (32)
//!   accounts: [0] ix sysvar, [1] payer (signer), [2] PDA, [3] revocation marker, [4] system program
use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, hash::hashv, instruction::{AccountMeta, Instruction},
    msg, program::invoke_signed, program_error::ProgramError, pubkey::Pubkey, rent::Rent, system_instruction,
    sysvar::{clock::Clock, instructions, Sysvar},
};

entrypoint!(process);

const ED25519: Pubkey = solana_program::pubkey!("Ed25519SigVerify111111111111111111111111111");
const SECP256K1: Pubkey = solana_program::pubkey!("KeccakSecp256k11111111111111111111111111111");
/// Squads Smart Account program: the only program a session may call.
const SMART_ACCOUNT: Pubkey = solana_program::pubkey!("SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG");
const CLUSTER: &str = match option_env!("PRIME_CLUSTER") { Some(c) => c, None => "localnet" };

fn err(code: u32, m: &str) -> ProgramError {
    msg!("prime-session: {}", m);
    ProgramError::Custom(code)
}

fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (&op, rest) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    let (&kind, rest) = rest.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    let olen = match kind { 0 => 20, 1 | 2 => 32, _ => return Err(ProgramError::InvalidInstructionData) };
    if rest.len() < olen { return Err(ProgramError::InvalidInstructionData) }
    let (owner, rest) = rest.split_at(olen);
    let [ix_sysvar, signer, pda, marker, tail @ ..] = accounts else { return Err(ProgramError::NotEnoughAccountKeys) };
    if *ix_sysvar.key != instructions::ID { return Err(err(1, "not the instructions sysvar")) }
    if !signer.is_signer { return Err(err(2, "session key / payer did not sign")) }
    let (expected, bump) = Pubkey::find_program_address(&[b"prime", &[kind], owner], program_id);
    if *pda.key != expected { return Err(err(3, "wrong PDA for this owner")) }

    match op {
        0 => {
            if rest.len() < 9 { return Err(ProgramError::InvalidInstructionData) }
            let valid_until = i64::from_le_bytes(rest[..8].try_into().unwrap());
            let sig_ix = rest[8] as usize;
            let inner = &rest[9..];
            let now = Clock::get()?.unix_timestamp;
            if now > valid_until || valid_until > now + 7 * 86_400 { return Err(err(4, "expired or longer than 7 days")) }
            let (m, _) = Pubkey::find_program_address(&[b"revoked", pda.key.as_ref(), signer.key.as_ref()], program_id);
            if *marker.key != m { return Err(err(8, "wrong revocation marker")) }
            if marker.lamports() > 0 { return Err(err(9, "session revoked")) }
            let text = format!("Prime session\nsigner: {}\nsession key: {}\nvalid until: {}\ncluster: {}\nprogram: {}", pda.key, signer.key, valid_until, CLUSTER, program_id);
            check_owner(kind, owner, sig_ix, ix_sysvar, &text)?;
            let [target, tail @ ..] = tail else { return Err(ProgramError::NotEnoughAccountKeys) };
            if *target.key != SMART_ACCOUNT { return Err(err(10, "sessions may only call the Smart Account program")) }
            let metas: Vec<AccountMeta> = tail.iter().map(|a| AccountMeta { pubkey: *a.key, is_signer: a.key == pda.key || a.is_signer, is_writable: a.is_writable }).collect();
            let mut infos: Vec<AccountInfo> = tail.to_vec();
            infos.push(pda.clone());
            invoke_signed(&Instruction { program_id: *target.key, accounts: metas, data: inner.to_vec() }, &infos, &[&[b"prime", &[kind], owner, &[bump]]])
        }
        1 => {
            if rest.len() < 33 { return Err(ProgramError::InvalidInstructionData) }
            let sig_ix = rest[0] as usize;
            let key = Pubkey::new_from_array(rest[1..33].try_into().unwrap());
            let (m, mbump) = Pubkey::find_program_address(&[b"revoked", pda.key.as_ref(), key.as_ref()], program_id);
            if *marker.key != m { return Err(err(8, "wrong revocation marker")) }
            let text = format!("Prime revoke\nsigner: {}\nsession key: {}\ncluster: {}\nprogram: {}", pda.key, key, CLUSTER, program_id);
            check_owner(kind, owner, sig_ix, ix_sysvar, &text)?;
            if marker.lamports() > 0 { return Ok(()) } // already revoked
            let [system, ..] = tail else { return Err(ProgramError::NotEnoughAccountKeys) };
            invoke_signed(
                &system_instruction::create_account(signer.key, marker.key, Rent::get()?.minimum_balance(0), 0, program_id),
                &[signer.clone(), marker.clone(), system.clone()],
                &[&[b"revoked", pda.key.as_ref(), key.as_ref(), &[mbump]]],
            )
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// The owner's signature over `text` must have been checked by the signature program at `sig_ix`.
fn check_owner(kind: u8, owner: &[u8], sig_ix: usize, ix_sysvar: &AccountInfo, text: &str) -> ProgramResult {
    let pre = instructions::load_instruction_at_checked(sig_ix, ix_sysvar)?;
    if kind == 0 {
        if pre.program_id != SECP256K1 { return Err(err(5, "not checked by the secp256k1 program")) }
        let mut m = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
        m.extend_from_slice(text.as_bytes());
        let (addr, msg_bytes) = secp_entry(&pre.data, sig_ix).ok_or_else(|| err(6, "bad secp256k1 instruction"))?;
        if addr != owner || msg_bytes != m.as_slice() { return Err(err(7, "not signed by the owner over this text")) }
    } else {
        if pre.program_id != ED25519 { return Err(err(5, "not checked by the ed25519 program")) }
        let m: Vec<u8> = if kind == 1 { hashv(&[b"Stellar Signed Message:\n", text.as_bytes()]).to_bytes().to_vec() } else { text.as_bytes().to_vec() };
        let (pk, msg_bytes) = ed_entry(&pre.data).ok_or_else(|| err(6, "bad ed25519 instruction"))?;
        if pk != owner || msg_bytes != m.as_slice() { return Err(err(7, "not signed by the owner over this text")) }
    }
    Ok(())
}

/// The single signature in an ed25519 program instruction whose data are all in that instruction (0xffff).
fn ed_entry(d: &[u8]) -> Option<(&[u8], &[u8])> {
    if d.len() < 16 || d[0] != 1 { return None }
    let u = |i: usize| u16::from_le_bytes([d[i], d[i + 1]]) as usize;
    let (pk_off, pk_ix, m_off, m_len, m_ix, s_ix) = (u(6), u(8), u(10), u(12), u(14), u(4));
    if pk_ix != 0xffff || m_ix != 0xffff || s_ix != 0xffff { return None }
    Some((d.get(pk_off..pk_off + 32)?, d.get(m_off..m_off + m_len)?))
}

/// The single signature in a secp256k1 program instruction whose three fields all come from that instruction.
fn secp_entry(d: &[u8], own_index: usize) -> Option<(&[u8], &[u8])> {
    if d.len() < 12 || d[0] != 1 { return None }
    let u = |i: usize| u16::from_le_bytes([d[i], d[i + 1]]) as usize;
    let (sig_ix, eth_off, eth_ix, m_off, m_len, m_ix) = (d[3] as usize, u(4), d[6] as usize, u(7), u(9), d[11] as usize);
    if sig_ix != own_index || eth_ix != own_index || m_ix != own_index { return None }
    Some((d.get(eth_off..eth_off + 20)?, d.get(m_off..m_off + m_len)?))
}
