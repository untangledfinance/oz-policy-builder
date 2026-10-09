#!/usr/bin/env python3
"""Mutation pass for the gate-owned gate. Each mutant weakens exactly one check of variants/gate-owned.rs (or, for the t-ids, of variants/gate-owned-thr.rs).
  mutants.py build            builds every mutant into mut/<id>.so (and mut/<id>.rs) and makes secrets/<id>.json
  mutants.py run [-j N] [id]  runs the whole harness against each mutant on the validator at port 9081 (start it with MUTANTS=1 ./restart-validator.sh), GATE_STOP_ON_FAIL=1.
                              A mutant is killed when a check fails; logs go to logs/gate/a4/mutants/<id>.log and the table to mutants.md."""
import os, re, subprocess, sys, time, shutil
from concurrent.futures import ThreadPoolExecutor
D = os.path.dirname(os.path.abspath(__file__))
L = '/home/ubuntu/work/prime-refine/logs/gate/a4/mutants'
SRC = open(f'{D}/variants/gate-owned.rs').read()
THR = open(f'{D}/variants/gate-owned-thr.rs').read()
LOADCHK = "    if gate.owner != pid { return Err(E::Custom(5)) }\n"
M = [
 ('o01', 'create: both lanes may be the same vault', 'd[52] != d[53] && d[52] != 0', 'd[52] != 0', None),
 ('o02', 'create: agent lane 0 (where session rules sign) is accepted', 'd[52] != d[53] && d[52] != 0 && d[53] != 0', 'd[52] != d[53] && d[53] != 0', None),
 ('o03', 'create: owners lane 0 is accepted', 'd[52] != 0 && d[53] != 0 =>', 'd[52] != 0 =>', None),
 ('o04', 'create: the destination list need not be whole 32-byte entries', ' && d.len() % 32 == 22', '', None),
 ('o05', 'create: the signer need not be a signer of the multisig', 'if w < 1 || m > n', 'if m > n', None),
 ('o06', 'create: a multisig with m greater than n is accepted', ' || m > n || settings.owner', ' || settings.owner', None),
 ('o07', 'create: the settings account need not be owned by Squads', ' || settings.owner != &SQUADS', '', None),
 ('o08', 'create: a Prime Account with a settings authority is accepted', ' || !autonomous', '', None),
 ('o09', 'votes: the identity need not belong to a token program', '    if !TOKEN.contains(ms.owner) { return Err(E::Custom(5)) }\n', '', None),
 ('o10', 'votes: a key counts although it did not sign', 'x.is_signer && ', '', None),
 ('o11', 'create: the seed is not part of the gate address', 'settings.key.as_ref(), &d[44..52]];', 'settings.key.as_ref(), &d[0..0]];', None),
 ('o12', 'create: the two lane vaults are stored swapped', 'vault(d[52]).as_ref(), vault(d[53]).as_ref()', 'vault(d[53]).as_ref(), vault(d[52]).as_ref()', None),
 ('o13', 'transfer: the lane need not sign', '!lane.is_signer || ', '', None),
 ('o14', 'transfer: any signer counts as a lane', ' || !(agent || owners)', '', None),
 ('o15', 'transfer: the not-after may have passed', 'if now > by || by > now +', 'if by > now +', None),
 ('o16', 'transfer: the not-after has no upper bound (custody\'s window)', 'now > by || by > now + u32::from_le_bytes(g[168..172].try_into().unwrap()) as i64', 'now > by', None),
 ('o17', 'transfer: the gate end time is ignored', 'now <= i64::from_le_bytes(g[160..168].try_into().unwrap()) && ', '', None),
 ('o18', 'transfer: the agent lane may pay any destination', ' && g[181..].chunks_exact(32).any(|x| x == to)', '', None),
 ('o19', 'transfer: the owners lane may pay any destination', 'else { to == g[128..160] }', 'else { true }', None),
 ('o20', 'transfer: the agent lane may pay the recovery address', '.any(|x| x == to) } else', '.any(|x| x == to) || to == g[128..160] } else', None),
 ('o21', 'transfer: the agent path accepts a source the cap PDA owns (no limit)', "    if src.try_borrow_data()?.get(32..64) != Some(gate.key.as_ref()) { return Err(E::Custom(5)) }\n", '', None),
 ('o22', 'call: any program may be named as the token program', "    if !TOKEN.contains(tok.key) { return Err(E::Custom(5)) }\n", '', None),
 ('o23', 'load: a gate account of another program is accepted', LOADCHK, '', None),
 ('o24', 'allow: one signer may raise the cap', 'w < if raise { m } else { 1 }', 'w < 1', None),
 ('o25', 'allow: the same cap counts as a raise', '< u64::from_le_bytes(d.try_into().unwrap());', '<= u64::from_le_bytes(d.try_into().unwrap());', None),
 ('o26', 'allow: the multisig need not be the gate\'s', 'if ms.key.as_ref() != &g[..32] || w < if raise', 'if w < if raise', None),
 ('o27', 'allow: the cap PDA account is not checked', 'if key != *cap.key || s[129..133]', 'if s[129..133]', None),
 ('o28', 'allow: a foreign close authority is accepted', ' || s[129..133] != [0; 4] && s[133..165] != *gate.key.as_ref()', '', None),
 ('o29', 'allow: an unset close authority is refused', 's[129..133] != [0; 4] && s[133..165]', 's[133..165]', None),
 ('o30', 'release: one signer may release', 'w < m { return Err(E::Custom(1)) }\n    for', 'w < 1 { return Err(E::Custom(1)) }\n    for', None),
 ('o31', 'release: the multisig need not be the gate\'s', 'if ms.key.as_ref() != &g[..32] || w < m', 'if w < m', None),
 ('o32', 'release: the owner changes before the close authority', 'for kind in [3, 2]', 'for kind in [2, 3]', None),
 ('o33', 'release: only the owner is handed back', 'for kind in [3, 2]', 'for kind in [2]', None),
 ('o34', 'release: only the close authority is handed back', 'for kind in [3, 2]', 'for kind in [3]', None),
 ('o35', 'transfer: the destination owner is read from the mint field', 'dst.try_borrow_data()?.get(32..64)', 'dst.try_borrow_data()?.get(0..32)', None),
 ('o36', 'transfer: the cap PDA signs with another seed (agent path)', '[b"cap", gate.key.as_ref()], pid).1;', '[b"cap2", gate.key.as_ref()], pid).1;', None),
 ('o37', 'create: the Allocate step is dropped', "        ([&[8, 0, 0, 0][..], &(body.len() as u64).to_le_bytes()].concat(), vec![g(true)]),\n", '', None),
 ('o38', 'allow: the gate approves its own address as the delegate (the cap PDA is not used)', 'AccountMeta::new_readonly(key, false), AccountMeta::new_readonly(*gate.key, true)];', 'AccountMeta::new_readonly(*gate.key, false), AccountMeta::new_readonly(*gate.key, true)];', None),
 ('o39', 'transfer: the owners lane signs as the cap PDA (bounded by the cap)', 'if owners { return call(a, tok, &data, metas(gate),', 'if false { return call(a, tok, &data, metas(gate),', None),
 ('o40', 'transfer: the owners lane is stopped by the end time', 'else { to == g[128..160] }', 'else { to == g[128..160] && now <= i64::from_le_bytes(g[160..168].try_into().unwrap()) }', None),
 ('o41', 'process: a create shorter than its fixed fields reaches create', 'd.len() >= 54 && d.len() % 32 == 22', 'd.len() % 32 == 22', None),
 ('o42', 'process: a transfer of the wrong length reaches transfer', 'Some((&1, d)) if d.len() == 16 =>', 'Some((&1, d)) =>', None),
 ('o43', 'process: an allow of the wrong length reaches allow', 'Some((&2, d)) if d.len() == 8 =>', 'Some((&2, d)) =>', None),
 ('o44', 'process: a release of the wrong length reaches release', 'Some((&3, d)) if d.len() == 32 =>', 'Some((&3, d)) =>', None),
 ('o45', 'allow: the current cap is read from the balance field', 'u64::from_le_bytes(s[121..129].try_into().unwrap())', 'u64::from_le_bytes(s[64..72].try_into().unwrap())', None),
 ('o46', 'release: the close authority is cleared instead of handed back', '&[6, kind, 1][..]', '&[6, kind, 0][..]', None),
 ('o47', 'votes: only the first two signer slots count', 'd[3..].chunks_exact(32)', 'd[3..67].chunks_exact(32)', None),
 ('o48', 'votes: m and n are read swapped', 'Ok((d[0] as usize, d[1] as usize, w))', 'Ok((d[1] as usize, d[0] as usize, w))', None),
 ('o49', 'create: the rent top-up transfers nothing', '([&[2, 0, 0, 0][..], &top].concat()', '([&[2, 0, 0, 0][..], &[0u8; 8]].concat()', None),
 ('o50', 'create: the Assign step is dropped', "        ([&[1, 0, 0, 0][..], pid.as_ref()].concat(), vec![g(true)]),\n", '', None),
 ('o51', 'create: the agent lane index is fixed at 1', 'vault(d[52]).as_ref()', 'vault(1).as_ref()', None),
 ('o52', 'create: the owners lane index is fixed at 3', 'vault(d[53]).as_ref()', 'vault(3).as_ref()', None),
 ('o53', 'transfer: the end time is exclusive (boundary second)', 'now <= i64::from_le_bytes(g[160..168]', 'now < i64::from_le_bytes(g[160..168]', None),
 ('o54', 'transfer: a not-after equal to now is refused (boundary second)', 'if now > by ||', 'if now >= by ||', None),
 # threshold-only variant: the same allow line, plus the one-signer-lowers rule being absent is the variant itself
 ('t01', 'thr: the threshold is not needed to change the cap', 'if ms.key.as_ref() != &g[..32] || w < m { return Err(E::Custom(1)) }\n    let key', 'if ms.key.as_ref() != &g[..32] || w < 1 { return Err(E::Custom(1)) }\n    let key', THR),
 ('t02', 'thr: the multisig need not be the gate\'s on allow', 'if ms.key.as_ref() != &g[..32] || w < m { return Err(E::Custom(1)) }\n    let key', 'if w < m { return Err(E::Custom(1)) }\n    let key', THR),
]

def build():
    os.makedirs(f'{D}/mut', exist_ok=True)
    env = dict(os.environ, PATH='/home/ubuntu/work/swig-spike/solana-release/bin:' + os.environ['PATH'])
    for mid, desc, old, new, base in M:
        if os.path.exists(f'{D}/mut/{mid}.so') and '-f' not in sys.argv: continue
        src = base or SRC
        assert src.count(old) == 1, (mid, old[:70], src.count(old))
        open(f'{D}/mut/{mid}.rs', 'w').write(src.replace(old, new))
        if not os.path.exists(f'{D}/secrets/{mid}.json'):
            subprocess.run(['solana-keygen', 'new', '--no-bip39-passphrase', '--silent', '-o', f'{D}/secrets/{mid}.json'], env=env, check=True, capture_output=True)
        shutil.copy(f'{D}/mut/{mid}.rs', f'{D}/gate/src/lib.rs')
        b = subprocess.run(['cargo-build-sbf', '--offline'], cwd=f'{D}/gate', env=env, capture_output=True, text=True)
        if b.returncode != 0: print(mid, 'BUILD FAILED', b.stderr[-400:]); continue
        shutil.copy(f'{D}/gate/target/deploy/gate.so', f'{D}/mut/{mid}.so'); print(mid, 'built', flush=True)

def run_one(mid, desc):
    env = dict(os.environ, GATE_ID=mid, GATE_STOP_ON_FAIL='1', GATE_STATE=f'/tmp/a4-mut-{mid}.json', GATE_VARIANT='thr' if mid.startswith('t') else 'split')
    t0 = time.time()
    with open(f'{L}/{mid}.log', 'w') as lf:
        try: subprocess.run(['bun', 'gate-a4.ts'], cwd=D, env=env, stdout=lf, stderr=subprocess.STDOUT, timeout=1700)
        except subprocess.TimeoutExpired: pass
    log = open(f'{L}/{mid}.log').read()
    fails = re.findall(r'^FAIL (\S+)', log, re.M)
    tot = re.search(r'(\d+)/(\d+) checks passed', log)
    crashed = tot is None and not fails
    res = 'killed' if fails else ('CRASHED' if crashed else 'SURVIVED')
    return (mid, desc, res, ', '.join(fails[:3]), tot.group(0) if tot else 'stopped at the first failure', f'{time.time() - t0:.0f}s')

def run(ids, workers):
    os.makedirs(L, exist_ok=True)
    todo = [(m[0], m[1]) for m in M if not ids or m[0] in ids]
    rows = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for r in ex.map(lambda a: run_one(*a), todo):
            rows.append(r); print(r, flush=True)
    out = f'{L}/../mutants.md' if not ids else f'{L}/../mutants-partial.md'
    with open(out, 'w') as f:
        f.write('| mutant | weakened check | result | first failing check | harness | time |\n|---|---|---|---|---|---|\n')
        for r in rows: f.write('| ' + ' | '.join(str(x) for x in r) + ' |\n')

if __name__ == '__main__':
    a = sys.argv[1:]
    if a and a[0] == 'build': build()
    elif a and a[0] == 'run':
        j = 3
        if '-j' in a: j = int(a[a.index('-j') + 1]); a = [x for x in a if x not in ('-j', str(j))]
        run(a[1:], j)
    else: print(__doc__)
