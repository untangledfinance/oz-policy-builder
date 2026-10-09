#!/usr/bin/env python3
"""rungs.py: the sLOC ladder of prime-session. r00 is the original after rustfmt (comments stripped); each rung applies one cut to the previous rung and is rustfmt'd again; r12 must equal variants/final.rs."""
import sys, re
exec(open('mk-ladder.py').read())

def r1(t):  # `pubkey` imported and `ProgramError as E`: the Smart Account constant fits one line, error returns are shorter
    t = sub(t, '''    program_error::ProgramError,
    pubkey::Pubkey,''', '''    program_error::ProgramError as E,
    pubkey,
    pubkey::Pubkey,''')
    t = t.replace('solana_program::pubkey!', 'pubkey!').replace('ProgramError::', 'E::')
    return t

def r2(t):  # one flat import list, `entrypoint!` by its path
    t = sub(t, '''use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    program_error::ProgramError as E,
    pubkey,
    pubkey::Pubkey,
    sysvar::{clock::Clock, instructions, rent::Rent, Sysvar},
};
entrypoint!(process);''', '''use solana_program::{
    account_info::AccountInfo, clock::Clock, entrypoint::ProgramResult, instruction::AccountMeta,
    instruction::Instruction, program::invoke_signed, program_error::ProgramError as E, pubkey,
    pubkey::Pubkey, rent::Rent, sysvar::instructions, sysvar::Sysvar,
};
solana_program::entrypoint!(process);''')
    return t

def r3(t):  # short parameter names
    t = sub(t, 'fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8])', 'fn process(pid: &Pubkey, a: &[AccountInfo], d: &[u8])')
    t = sub(t, '(&data[..32], &data[32..64], &data[64..])', '(&d[..32], &d[32..64], &d[64..])')
    t = t.replace('= accounts else', '= a else')
    t = re.sub(r'(?<![.\w])program_id\b(?!:)', 'pid', t)
    t = sub(t, '|data: &[u8], a: Vec<AccountMeta>|', '|d: &[u8], m: Vec<AccountMeta>|')
    t = sub(t, 'Pubkey::default(), data, a)', 'Pubkey::default(), d, m)')
    t = sub(t, '                accounts,\n                seeds,', '                a,\n                seeds,')
    t = sub(t, '        accounts,\n        &[&[b"prime"', '        a,\n        &[&[b"prime"')
    return t

def r4(t):  # the account list taken apart with split_first_chunk
    return sub(t, '''    let [ix_sysvar, signer, pda, _smart_account, marker, tail @ ..] = a else {
        return Err(E::NotEnoughAccountKeys);
    };''', '''    let ([ix_sysvar, signer, pda, _smart_account, marker], tail) =
        a.split_first_chunk().ok_or(E::NotEnoughAccountKeys)?;''')

def r5(t):  # `need` and `le` helpers: the four refusals as one-line checks, little-endian numbers by one fold
    t = sub(t, '''    let (key, until, sig_ix, bump, inner) = (
        *signer.key,
        i64::from_le_bytes(rest[..8].try_into().unwrap()),
        rest[8],
        rest[9],
        &rest[10..],
    );
    if !signer.is_signer && until != 0 {
        return Err(E::MissingRequiredSignature);
    }''', '''    let (key, until, sig_ix, bump, inner) = (
        *signer.key,
        le(&rest[..8]) as i64,
        rest[8],
        rest[9],
        &rest[10..],
    );
    need(signer.is_signer || until == 0, E::MissingRequiredSignature)?;''')
    t = sub(t, '''    if now > until || until > now + 7 * 86_400 {
        return Err(E::Custom(4));
    }''', '''    need(now <= until && until <= now + 7 * 86_400, E::Custom(4))?;''')
    t += '''fn need(ok: bool, e: E) -> ProgramResult {
    ok.then_some(()).ok_or(e)
}
fn le(b: &[u8]) -> usize {
    b.iter().rev().fold(0, |x, &y| x << 8 | y as usize)
}
'''
    return t

def r6(t):  # the ed25519 header read as eight words in one slice pattern (no per-field closure, no Option chain)
    t = sub(t, '''    let (d, u) = (&pre.data, |i: usize| {
        pre.data
            .get(i..i + 2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]) as usize)
    });
    let own = pre.program_id == ED25519
        && d.first() == Some(&1)
        && [u(4), u(8), u(14)].iter().all(|&i| i == Some(0xffff));
    let signed = (|| Some((d.get(u(6)?..u(6)? + 32)?, d.get(u(10)?..u(10)? + u(12)?)?)))();
    if !own || signed != Some((owner, text.as_bytes())) {
        return Err(E::Custom(7));
    }''', '''    let w: Vec<usize> = pre.data.chunks_exact(2).take(8).map(le).collect();
    let [c, _, 0xffff, k, 0xffff, o, n, 0xffff] = w[..] else {
        return Err(E::Custom(7));
    };
    let ok = pre.program_id == ED25519 && c % 256 == 1 && pre.data.get(k..k + 32) == Some(owner);
    let ok = ok && pre.data.get(o..o + n) == Some(text.as_bytes());
    need(ok, E::Custom(7))?;''')
    return t

def r7(t):  # `key` dropped (the tuple that copied the session key goes) and the seeds named once
    t = sub(t, '''    let (key, until, sig_ix, bump, inner) = (
        *signer.key,
        le(&rest[..8]) as i64,
        rest[8],
        rest[9],
        &rest[10..],
    );''', '''    let until = le(&rest[..8]) as i64;
    let (sig_ix, bump, inner) = (rest[8], rest[9], &rest[10..]);''')
    t = t.replace('pda.key, key, until, CLUSTER', 'pda.key, signer.key, until, CLUSTER')
    t = re.sub(r'(?<![.\w])key\.as_ref\(\)', 'signer.key.as_ref()', t)
    return t

def r8(t):  # the PDA check: marker test and PDA test as two named conditions, `seeds` bound once and shared with the inner call
    t = sub(t, '''    let (m, mb) = Pubkey::find_program_address(&[owner, settings, signer.key.as_ref()], pid);
    if m != *marker.key
        || marker.owner == pid
        || Pubkey::create_program_address(&[b"prime", owner, settings, &[bump]], pid)? != *pda.key
    {
        return Err(E::Custom(2));
    }''', '''    let seeds = [b"prime".as_ref(), owner, settings, &[bump]];
    let (m, mb) = Pubkey::find_program_address(&[owner, settings, signer.key.as_ref()], pid);
    let ok = m == *marker.key && marker.owner != pid;
    let pk = Pubkey::create_program_address(&seeds, pid);
    need(ok && pk? == *pda.key, E::Custom(2))?;''')
    return t

def r9(t):  # revoke: one system-call closure that takes the instruction tag, so the two data builders at the call sites go; rent and payer bound by name
    t = sub(t, '''        let seeds: &[&[&[u8]]] = &[&[owner, settings, signer.key.as_ref(), &[mb]]];
        let sys = |d: &[u8], m: Vec<AccountMeta>| {
            invoke_signed(
                &Instruction::new_with_bytes(Pubkey::default(), d, m),
                a,
                seeds,
            )
        };
        sys(
            &[
                &[2, 0, 0, 0][..],
                &Rent::get()?.minimum_balance(0).to_le_bytes(),
            ]
            .concat(),
            vec![
                AccountMeta::new(*tail[0].key, true),
                AccountMeta::new(m, false),
            ],
        )?;
        return sys(
            &[&[1, 0, 0, 0][..], pid.as_ref()].concat(),
            vec![AccountMeta::new(m, true)],
        );''', '''        let ms = [owner, settings, signer.key.as_ref(), &[mb]];
        let sys = |tag: u8, x: &[u8], metas| {
            let d = [&[tag, 0, 0, 0][..], x].concat();
            let ix = Instruction::new_with_bytes(Pubkey::default(), &d, metas);
            invoke_signed(&ix, a, &[&ms])
        };
        let rent = Rent::get()?.minimum_balance(0).to_le_bytes();
        let pay = AccountMeta::new(*tail[0].key, true);
        sys(2, &rent, vec![pay, AccountMeta::new(m, false)])?;
        return sys(1, pid.as_ref(), vec![AccountMeta::new(m, true)]);''')
    return t

def r10(t):  # the Smart Account call built with new_with_bytes (the struct literal and `inner.to_vec()` go), signing with the shared seeds
    return sub(t, '''    invoke_signed(
        &Instruction {
            program_id: SMART_ACCOUNT,
            accounts: metas,
            data: inner.to_vec(),
        },
        a,
        &[&[b"prime", owner, settings, &[bump]]],
    )''', '''    let ix = Instruction::new_with_bytes(SMART_ACCOUNT, inner, metas);
    invoke_signed(&ix, a, &[&seeds])''')

titles = ['`pubkey` imported and `ProgramError as E`', 'one flat import list, `entrypoint!` by its path', 'short parameter names', 'account list taken apart with split_first_chunk',
          '`need` and `le` helpers: refusals as one-line checks, numbers by one fold', 'ed25519 header read as eight words in one slice pattern', 'session key not copied into a tuple',
          'PDA check as two named conditions with the seeds bound once', 'revoke: one system-call closure taking the instruction tag', 'Smart Account call through new_with_bytes']
rs = [r1, r2, r3, r4, r5, r6, r7, r8, r9, r10]
if __name__ == '__main__':
    for i, (f, ti) in enumerate(zip(rs, titles), 1): rung(i, ti, f)
    code = lambda p: [l for l in open(p).read().splitlines() if l.strip() and not l.strip().startswith('//')]
    print('r10 == final (code lines):', code('r10.rs') == code('../variants/final.rs'))
