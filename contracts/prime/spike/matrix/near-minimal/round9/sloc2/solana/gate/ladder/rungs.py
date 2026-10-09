import sys
sys.path.insert(0, '.')
exec(open('mk-ladder.py').read())

def r1(t):  # read: one `?` chain
    return sub(t, '''    x.try_borrow_data()?
        .get(r)
        .map(<[u8]>::to_vec)
        .ok_or(E::Custom(5))
''', '''    Ok(x.try_borrow_data()?.get(r).ok_or(E::Custom(5))?.to_vec())
''')

def r2(t):  # token ids: two constants
    t = sub(t, '''const TOKEN: [Pubkey; 2] = [
    pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
];''', '''const TOKEN: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_22: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");''')
    t = sub(t, 'TOKEN.contains(ms.owner)', '[TOKEN, TOKEN_22].contains(ms.owner)')
    t = sub(t, 'TOKEN.contains(tok.key)', '[TOKEN, TOKEN_22].contains(tok.key)')
    return t

def r3(t):  # create guard
    return sub(t, '''            if d.len() >= 54
                && d.len() % 32 == 22
                && d[52] != d[53]
                && d[52] != 0
                && d[53] != 0 =>''', '''            if d.len() >= 54 && d.len() % 32 == 22 && d[52] != d[53] && d[52].min(d[53]) > 0 =>''')

def r4(t):  # long conditions bound to a name before need()
    t = sub(t, '''    need(
        w >= 1 && m <= n && settings.owner == &SQUADS && read(settings, 24..56)? == [0; 32],
        5,
    )?;''', '''    let ok = w >= 1 && m <= n && settings.owner == &SQUADS && read(settings, 24..56)? == [0; 32];
    need(ok, 5)?;''')
    t = sub(t, '''    need(
        ms.key.as_ref() == &g[..32] && w >= if le(&s[121..129]) < le(d) { m } else { 1 },
        1,
    )?;''', '''    let ok = ms.key.as_ref() == &g[..32] && w >= if le(&s[121..129]) < le(d) { m } else { 1 };
    need(ok, 1)?;''')
    t = sub(t, '''    need(
        Pubkey::find_program_address(&[b"cap", gate.key.as_ref()], pid).0 == *cap.key
            && (s[129..133] == [0; 4] || s[133..165] == *gate.key.as_ref()),
        5,
    )?;''', '''    let gk = gate.key.as_ref();
    let ok = Pubkey::find_program_address(&[b"cap", gk], pid).0 == *cap.key;
    need(ok && (s[129..133] == [0; 4] || s[133..165] == *gk), 5)?;''')
    return t

def r5(t):  # transfer: one lane test, the other lane is "not the agent"; one list for the destination test
    t = sub(t, '''    let (agent, owners) = (
        lane.key.as_ref() == &g[64..96],
        lane.key.as_ref() == &g[96..128],
    );
    need(lane.is_signer && (agent || owners), 1)?;''', '''    let l = lane.key.as_ref();
    let agent = l == &g[64..96];
    need(lane.is_signer && (agent || l == &g[96..128]), 1)?;''')
    t = sub(t, '''    need(
        if agent {
            now <= le(&g[160..168]) as i64 && g[181..].chunks_exact(32).any(|x| x == to)
        } else {
            to == g[128..160]
        },
        2,
    )?;''', '''    let list = if agent { &g[181..] } else { &g[128..160] };
    let ok = (!agent || now <= le(&g[160..168]) as i64) && list.chunks_exact(32).any(|x| x == to);
    need(ok, 2)?;''')
    t = sub(t, '    if owners {', '    if !agent {')
    return t

def r6(t):  # transfer: the cap seeds bound once; allow and transfer data bound before the call
    t = sub(t, '''    let bump = Pubkey::find_program_address(&[b"cap", gate.key.as_ref()], pid).1;
    need(read(src, 32..64)? == gate.key.as_ref(), 5)?;
    call(
        a,
        tok,
        data,
        &[src, dst, cap],
        2,
        &[b"cap", gate.key.as_ref(), &[bump]],
    )''', '''    let gk = gate.key.as_ref();
    need(read(src, 32..64)? == gk, 5)?;
    let bump = Pubkey::find_program_address(&[b"cap", gk], pid).1;
    call(a, tok, data, &[src, dst, cap], 2, &[b"cap", gk, &[bump]])''')
    t = sub(t, '''    call(
        a,
        tok,
        [&[4][..], d].concat(),
        &[src, cap, gate],
        1,
        &gate_seeds(&g),
    )''', '''    let data = [&[4][..], d].concat();
    call(a, tok, data, &[src, cap, gate], 1, &gate_seeds(&g))''')
    return t

rs = [r1, r2, r3, r4, r5, r6]
titles = ['read: one `?` chain', 'token programs as two constants', 'create guard: one minimum test for both lanes', 'long conditions bound to a name before need()', 'transfer: one lane test, one destination list', 'cap seeds and token data bound once']
if __name__ == '__main__':
    for i, (f, ti) in enumerate(zip(rs, titles), 1):
        rung(i, ti, f)
