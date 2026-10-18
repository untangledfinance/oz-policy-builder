#!/usr/bin/env python3
"""rungs2.py: continues the ladder from r06 to the final gate (variants/final.rs). Run from this directory after rungs.py. r00 is the original gate after rustfmt; each rung applies one cut to the previous rung and is rustfmt'd again."""
import re, sys
exec(open('rungs.py').read().split("if __name__ == '__main__':")[0])

def r7(t):  # create: the two lane vaults from one `map` over their indexes, with the shared seed word as a constant
    t = sub(t, '''    let vault = |i: u8| {
        Pubkey::find_program_address(
            &[
                b"smart_account",
                settings.key.as_ref(),
                b"smart_account",
                &[i],
            ],
            &SQUADS,
        )
        .0
    };
''', '''    let [x, y] = [d[52], d[53]].map(|i| {
        Pubkey::find_program_address(&[SA, settings.key.as_ref(), SA, &[i]], &SQUADS).0
    });
''')
    t = sub(t, 'fn process(', 'const SA: &[u8] = b"smart_account";\nfn process(')
    t = sub(t, '        vault(d[52]).as_ref(),\n        vault(d[53]).as_ref(),\n', '        x.as_ref(),\n        y.as_ref(),\n')
    return t

def r8(t):  # create: the multisig and settings keys named once
    t = sub(t, '    let [x, y] = [d[52], d[53]]\n        .map(|i| Pubkey::find_program_address(&[SA, settings.key.as_ref(), SA, &[i]], &SQUADS).0);',
            '    let (mk, sk) = (ms.key.as_ref(), settings.key.as_ref());\n    let [x, y] = [d[52], d[53]].map(|i| Pubkey::find_program_address(&[SA, sk, SA, &[i]], &SQUADS).0);')
    t = sub(t, '''    let seeds = [
        b"gate".as_ref(),
        ms.key.as_ref(),
        settings.key.as_ref(),
        &d[44..52],
    ];''', '''    let seeds = [b"gate".as_ref(), mk, sk, &d[44..52]];''')
    t = sub(t, '''    let body = [
        ms.key.as_ref(),
        settings.key.as_ref(),
        x.as_ref(),''', '''    let body = [
        mk,
        sk,
        x.as_ref(),''')
    return t

def r9(t):  # create: the signer seeds of the system calls read back from the body, so the `seeds` array goes
    t = sub(t, '''    let seeds = [b"gate".as_ref(), mk, sk, &d[44..52]];
    let bump = [Pubkey::find_program_address(&seeds, pid).1];
''', '''    let bump = [Pubkey::find_program_address(&[b"gate", mk, sk, &d[44..52]], pid).1];
''')
    t = sub(t, '            &[seeds[0], seeds[1], seeds[2], seeds[3], &bump],\n', '            &gate_seeds(&body),\n')
    return t

def r10(t):  # create: the system calls build their instruction directly instead of through the token-call helper
    t = sub(t, '''    let sys = |tag: u8, x: &[u8], keys: &[&AccountInfo]| {
        cpi(
            a,
            &Pubkey::default(),
            [&[tag, 0, 0, 0][..], x].concat(),
            keys,
            keys.len(),
            keys.len(),
            &gate_seeds(&body),
        )
    };''', '''    let sys = |tag: u8, x: &[u8], k: &[&AccountInfo]| {
        let (d, s) = ([&[tag, 0, 0, 0][..], x].concat(), gate_seeds(&body));
        let m = k.iter().map(|x| AccountMeta::new(*x.key, true)).collect();
        let ix = Instruction::new_with_bytes(Pubkey::default(), &d, m);
        invoke_signed(&ix, a, &[&s])
    };''')
    return t

def r11(t):  # create: the rent bound before the call, and the copy as the tail expression
    t = sub(t, '''    sys(
        2,
        &Rent::get()?.minimum_balance(body.len()).to_le_bytes(),
        &[member, gate],
    )?;''', '''    let rent = Rent::get()?.minimum_balance(body.len()).to_le_bytes();
    sys(2, &rent, &[member, gate])?;''')
    t = sub(t, '    gate.try_borrow_mut_data()?.copy_from_slice(&body);\n    Ok(())\n', '    Ok(gate.try_borrow_mut_data()?.copy_from_slice(&body))\n')
    return t

def r12(t):  # the account list taken apart in one expression (array try_from, split_first_chunk) and transfer's two key refs in one tuple
    for n, names in ((5, 'member, gate, settings, _system, ms'), (6, 'gate, lane, src, dst, tok, cap')):
        t = sub(t, f'''    let [{names}] = a else {{
        return Err(E::NotEnoughAccountKeys);
    }};''', f'''    let [{names}] =
        <&[AccountInfo; {n}]>::try_from(a).map_err(|_| E::NotEnoughAccountKeys)?;''')
    t = sub(t, '''    let [gate, src, tok, ms, cap, signers @ ..] = a else {
        return Err(E::NotEnoughAccountKeys);
    };''', '''    let ([gate, src, tok, ms, cap], sig) = a.split_first_chunk().ok_or(E::NotEnoughAccountKeys)?;''')
    t = sub(t, '''    let [gate, src, tok, ms, signers @ ..] = a else {
        return Err(E::NotEnoughAccountKeys);
    };''', '''    let ([gate, src, tok, ms], sig) = a.split_first_chunk().ok_or(E::NotEnoughAccountKeys)?;''')
    t = sub(t, 'votes(ms, signers)?', 'votes(ms, sig)?', 2)
    t = sub(t, '    let l = lane.key.as_ref();\n', '    let (l, gk) = (lane.key.as_ref(), gate.key.as_ref());\n')
    t = sub(t, '    let gk = gate.key.as_ref();\n    need(read(src, 32..64)? == gk, 5)?;', '    need(read(src, 32..64)? == gk, 5)?;')
    return t

def r13(t):  # call: the token program is the first key and the helper builds the instruction itself (the `cpi` helper and one parameter go)
    t = sub(t, '''fn call(
    a: &[AccountInfo],
    tok: &AccountInfo,
    data: Vec<u8>,
    keys: &[&AccountInfo],
    w: usize,
    seeds: &[&[u8]],
) -> ProgramResult {
    need([TOKEN, TOKEN_22].contains(tok.key), 5)?;
    cpi(a, tok.key, data, keys, w, 1, seeds)
}
fn cpi(
    a: &[AccountInfo],
    prog: &Pubkey,
    data: Vec<u8>,
    keys: &[&AccountInfo],
    w: usize,
    s: usize,
    seeds: &[&[u8]],
) -> ProgramResult {
    let accounts = keys
        .iter()
        .enumerate()
        .map(|(i, k)| AccountMeta {
            pubkey: *k.key,
            is_writable: i < w,
            is_signer: i + s >= keys.len(),
        })
        .collect();
    invoke_signed(
        &Instruction {
            program_id: *prog,
            accounts,
            data,
        },
        a,
        &[seeds],
    )
}''', '''fn call(a: &[AccountInfo], d: Vec<u8>, k: &[&AccountInfo], w: usize, s: &[&[u8]]) -> ProgramResult {
    need([TOKEN, TOKEN_22].contains(k[0].key), 5)?;
    let m = k
        .iter()
        .enumerate()
        .skip(1)
        .map(|(i, x)| AccountMeta {
            pubkey: *x.key,
            is_writable: i <= w,
            is_signer: i + 1 == k.len(),
        })
        .collect();
    invoke_signed(&Instruction::new_with_bytes(*k[0].key, &d, m), a, &[s])
}''')
    t = sub(t, 'call(a, tok, data, &[src, dst, gate], 2,', 'call(a, data, &[tok, src, dst, gate], 2,')
    t = sub(t, 'call(a, tok, data, &[src, dst, cap], 2,', 'call(a, data, &[tok, src, dst, cap], 2,')
    t = sub(t, 'call(a, tok, data, &[src, cap, gate], 1,', 'call(a, data, &[tok, src, cap, gate], 1,')
    t = sub(t, '''        call(
            a,
            tok,
            [&[6, *kind, 1][..], d].concat(),
            &[src, gate],
            1,
            &gate_seeds(&g),
        )''', '''        call(
            a,
            [&[6, *kind, 1][..], d].concat(),
            &[tok, src, gate],
            1,
            &gate_seeds(&g),
        )''')
    return t

def r14(t):  # release: the two hand-backs as two calls of one data builder
    return sub(t, '''    [3, 2].iter().try_for_each(|kind| {
        call(
            a,
            [&[6, *kind, 1][..], d].concat(),
            &[tok, src, gate],
            1,
            &gate_seeds(&g),
        )
    })''', '''    let (gs, c) = (gate_seeds(&g), |k: u8| [&[6, k, 1][..], d].concat());
    call(a, c(3), &[tok, src, gate], 1, &gs)?;
    call(a, c(2), &[tok, src, gate], 1, &gs)''')

def r15(t):  # votes: the signer test named once
    return sub(t, '''    let w = d[3..]
        .chunks_exact(32)
        .filter(|s| a.iter().any(|x| x.is_signer && x.key.as_ref() == *s))
        .count();''', '''    let signs = |s: &[u8]| a.iter().any(|x| x.is_signer && x.key.as_ref() == s);
    let w = d[3..].chunks_exact(32).filter(|s| signs(s)).count();''')

def r16(t):  # imports as one flat list (a nested `{}` group makes rustfmt break the whole list, one name per line)
    return sub(t, '''use solana_program::{
    account_info::AccountInfo,
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    program_error::ProgramError as E,
    pubkey,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};''', '''use solana_program::{
    account_info::AccountInfo, clock::Clock, entrypoint, entrypoint::ProgramResult,
    instruction::AccountMeta, instruction::Instruction, program::invoke_signed,
    program_error::ProgramError as E, pubkey, pubkey::Pubkey, rent::Rent, sysvar::Sysvar,
};''')

titles2 = ['create: lane vaults from one map over their indexes, the shared seed word as a constant', 'create: multisig and settings keys named once', 'create: signer seeds read back from the body, the seeds array goes',
           'create: system calls build their instruction directly, no helper call', 'create: rent bound before the call, the copy as the tail expression', 'account lists taken apart in one expression (try_from, split_first_chunk)',
           'call: token program as the first key, the cpi helper folds into call', 'release: two calls of one data builder', 'votes: the signer test named once', 'imports as one flat list']
rs2 = [r7, r8, r9, r10, r11, r12, r13, r14, r15, r16]
if __name__ == '__main__':
    for i, (f, ti) in enumerate(zip(rs2, titles2), 7): rung(i, ti, f)
    code = lambda p: [l for l in open(p).read().splitlines() if l.strip() and not l.strip().startswith('//')]
    fin = '/tmp/ld/final-code.rs'
    open(fin, 'w').write('\n'.join(l for l in open('../variants/final.rs').read().splitlines() if l.strip() and not l.strip().startswith('//')) + '\n')
    print('r16 == final (code lines):', code('r16.rs') == code(fin))
