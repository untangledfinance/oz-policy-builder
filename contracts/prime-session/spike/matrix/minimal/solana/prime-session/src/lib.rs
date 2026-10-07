//! prime-session: one wallet signature -> a short-lived session key that acts as the wallet's PDA signer on
//! the Squads Smart Account (its seat and its policy member). Stateless: the grant is re-checked on every move
//! by Solana's ed25519 / secp256k1 programs (instruction introspection), so nothing is stored but revocations.
//!
//! PDA = ["prime", kind, owner] (kind 0 = MetaMask address 20 B, 1 = Freighter ed25519, 2 = Phantom ed25519).
//! The wallet signs: "Prime session\nsigner: <PDA>\nsession key: <key>\nvalid until (unix time): <t>\ncluster: <c>\nprogram: <id>"
//!   MetaMask personal_sign; Freighter SEP-53 (sha256 of the prefixed text); Phantom signMessage (the text).
//!   Revoking is the same text with t = 0 (which can never authorise).
//!
//! execute: 0 | kind | owner | t i64 | sig_ix u8 | Smart Account instruction data
//!   accounts: [0] ix sysvar, [1] session key (signer), [2] PDA, [3] revocation marker, [4] Smart Account program, [5..] its accounts
//! revoke:  1 | kind | owner | sig_ix u8 | session key (32)
//!   accounts: [0] ix sysvar, [1] payer (signer), [2] PDA, [3] revocation marker, [4] system program
use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, hash::hashv, instruction::{AccountMeta, Instruction},
    msg, program::{invoke, invoke_signed}, program_error::ProgramError, pubkey::Pubkey, rent::Rent, system_instruction,
    sysvar::{clock::Clock, instructions, Sysvar},
};

entrypoint!(process);

const ED25519: Pubkey = solana_program::pubkey!("Ed25519SigVerify111111111111111111111111111");
const SECP256K1: Pubkey = solana_program::pubkey!("KeccakSecp256k11111111111111111111111111111");
const SMART_ACCOUNT: Pubkey = solana_program::pubkey!("SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG");
const CLUSTER: &str = match option_env!("PRIME_CLUSTER") { Some(c) => c, None => "localnet" };

fn err(code: u32, m: &str) -> ProgramError {
    msg!("prime-session: {}", m);
    ProgramError::Custom(code)
}

fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let bad = ProgramError::InvalidInstructionData;
    let [op, kind, rest @ ..] = data else { return Err(bad) };
    let olen = match kind { 0 => 20, 1 | 2 => 32, _ => return Err(bad) };
    if rest.len() < olen + 9 { return Err(bad) }
    let (owner, rest) = rest.split_at(olen);
    let [ix_sysvar, signer, pda, marker, next, tail @ ..] = accounts else { return Err(ProgramError::NotEnoughAccountKeys) };
    if !signer.is_signer { return Err(err(2, "session key / payer did not sign")) }
    let (expected, bump) = Pubkey::find_program_address(&[b"prime", &[*kind], owner], program_id);
    if *pda.key != expected { return Err(err(3, "wrong PDA for this owner")) }
    let (key, until, sig_ix, inner) = match op {
        0 => (*signer.key, i64::from_le_bytes(rest[..8].try_into().unwrap()), rest[8], &rest[9..]),
        1 if rest.len() >= 33 => (Pubkey::new_from_array(rest[1..33].try_into().unwrap()), 0, rest[0], &[][..]),
        _ => return Err(bad),
    };
    let (m, mbump) = Pubkey::find_program_address(&[b"revoked", pda.key.as_ref(), key.as_ref()], program_id);
    if *marker.key != m { return Err(err(8, "wrong revocation marker")) }
    let text = format!("Prime session\nsigner: {}\nsession key: {}\nvalid until (unix time): {}\ncluster: {}\nprogram: {}", pda.key, key, until, CLUSTER, program_id);
    check_owner(*kind, owner, sig_ix as usize, ix_sysvar, &text)?;
    let revoked = marker.owner == program_id;

    if *op == 1 {
        // Fund the marker to rent exemption (whatever someone already sent it) and take ownership of it.
        if revoked { return Ok(()) }
        let short = Rent::get()?.minimum_balance(0).saturating_sub(marker.lamports());
        if short > 0 { invoke(&system_instruction::transfer(signer.key, marker.key, short), &[signer.clone(), marker.clone(), next.clone()])? }
        return invoke_signed(&system_instruction::assign(marker.key, program_id), &[marker.clone(), next.clone()], &[&[b"revoked", pda.key.as_ref(), key.as_ref(), &[mbump]]]);
    }
    let now = Clock::get()?.unix_timestamp;
    if now > until || until > now + 7 * 86_400 { return Err(err(4, "expired or longer than 7 days")) }
    if revoked { return Err(err(9, "session revoked")) }
    if *next.key != SMART_ACCOUNT { return Err(err(10, "sessions may only call the Smart Account program")) }
    let metas = tail.iter().map(|a| AccountMeta { pubkey: *a.key, is_signer: a.key == pda.key || a.is_signer, is_writable: a.is_writable }).collect();
    let mut infos = tail.to_vec();
    infos.push(pda.clone());
    invoke_signed(&Instruction { program_id: SMART_ACCOUNT, accounts: metas, data: inner.to_vec() }, &infos, &[&[b"prime", &[*kind], owner, &[bump]]])
}

/// The owner's signature over `text` must have been checked, in this transaction, by the signature program
/// instruction at `sig_ix`, with every field read from that instruction itself.
fn check_owner(kind: u8, owner: &[u8], sig_ix: usize, ix_sysvar: &AccountInfo, text: &str) -> ProgramResult {
    let pre = instructions::load_instruction_at_checked(sig_ix, ix_sysvar)?; // also checks the sysvar id
    let d = &pre.data;
    let u = |i: usize| d.get(i..i + 2).map(|b| u16::from_le_bytes([b[0], b[1]]) as usize);
    let (prog, m, signed) = if kind == 0 {
        let mut m = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
        m.extend_from_slice(text.as_bytes());
        // count | sig_off u16, sig_ix u8 | eth_off u16, eth_ix u8 | msg_off u16, msg_len u16, msg_ix u8
        let own = |i: usize| d.get(i).map(|&x| x as usize) == Some(sig_ix);
        let ok = d.first() == Some(&1) && own(3) && own(6) && own(11);
        (SECP256K1, m, ok.then(|| Some((d.get(u(4)?..u(4)? + 20)?, d.get(u(7)?..u(7)? + u(9)?)?))).flatten())
    } else {
        let m = if kind == 1 { hashv(&[b"Stellar Signed Message:\n", text.as_bytes()]).to_bytes().to_vec() } else { text.as_bytes().to_vec() };
        // count, pad | sig_off, sig_ix | pk_off, pk_ix | msg_off, msg_len, msg_ix (u16 each); 0xffff = this instruction
        let ok = d.first() == Some(&1) && [u(4), u(8), u(14)].iter().all(|&i| i == Some(0xffff));
        (ED25519, m, ok.then(|| Some((d.get(u(6)?..u(6)? + 32)?, d.get(u(10)?..u(10)? + u(12)?)?))).flatten())
    };
    if pre.program_id != prog { return Err(err(5, "not checked by the signature program")) }
    match signed {
        Some((o, msg_bytes)) if o == owner && msg_bytes == m.as_slice() => Ok(()),
        Some(_) => Err(err(7, "not signed by the owner over this text")),
        None => Err(err(6, "bad signature instruction")),
    }
}
