#!/usr/bin/env python3
"""Mutation pass for the sLOC pass 2 gate (variants/final.rs, ids n01..). Each mutant weakens exactly one check or one piece of the new helpers.
  mutants3.py check                  every pattern must occur exactly once in the source
  mutants3.py build [id...]          builds every mutant into mut/<id>.so (+ .rs) and makes secrets/<id>.json
  mutants3.py run [-j N] [id...]     runs the whole mock-venue harness (gate-a4.ts) against each mutant, GATE_STOP_ON_FAIL=1, on the validator at GATE_RPC (start it with MUTANTS=1 MUTSET=n)
A mutant is killed when a check fails; logs go to logs/mutants-new/<id>.log and the table to logs/mutants-new.md."""
import os, re, subprocess, sys, time, shutil
from concurrent.futures import ThreadPoolExecutor
D = os.path.dirname(os.path.abspath(__file__))
SRC = f'{D}/variants/final.rs'; CRATE = f'{D}/mutcrate'; P = 'n'
GUARD = 'd.len() >= 54 && d.len() % 32 == 22 && d[52] != d[53] && d[52].min(d[53]) > 0'
# (suffix, description, old, new[, expect-refuse probe])
M = [
 ('01', 'create: both lanes may be the same vault', ' && d[52] != d[53] && d[52].min(d[53]) > 0 =>', ' && d[52].min(d[53]) > 0 =>'),
 ('02', 'create: agent lane 0 (where session rules sign) is accepted', 'd[52].min(d[53]) > 0 =>', 'd[53] > 0 =>'),
 ('03', 'create: owners lane 0 is accepted', 'd[52].min(d[53]) > 0 =>', 'd[52] > 0 =>'),
 ('04', 'create: the destination list need not be whole 32-byte entries', ' && d.len() % 32 == 22', ''),
 ('05', 'create: the signer need not be a signer of the multisig', 'let ok = w >= 1 && m <= n', 'let ok = m <= n'),
 ('06', 'create: a multisig with m greater than n is accepted', ' && m <= n && settings.owner', ' && settings.owner'),
 ('07', 'create: the settings account need not be owned by Squads', ' && settings.owner == &SQUADS', ''),
 ('08', 'create: a Prime Account with a settings authority is accepted', ' && read(settings, 24..56)? == [0; 32]', ''),
 ('09', 'votes: the identity need not belong to a token program', 'need([TOKEN, TOKEN_22].contains(ms.owner) && d.len() == 355, 5)?;', 'need(d.len() == 355, 5)?;'),
 ('10', 'votes: a key counts although it did not sign', 'x.is_signer && x.key.as_ref() == s', 'x.key.as_ref() == s'),
 ('11', 'create: the seed is not part of the gate address', '&[b"gate", mk, sk, &d[44..52]]', '&[b"gate", mk, sk, &d[0..0]]'),
 ('12', 'create: the two lane vaults are stored swapped', 'x.as_ref(), y.as_ref()', 'y.as_ref(), x.as_ref()'),
 ('13', 'transfer: the lane need not sign', 'need(lane.is_signer && (agent || l == &g[96..128]), 1)?;', 'need(agent || l == &g[96..128], 1)?;'),
 ('14', 'transfer: any signer counts as a lane', 'need(lane.is_signer && (agent || l == &g[96..128]), 1)?;', 'need(lane.is_signer, 1)?;'),
 ('15', 'transfer: the not-after may have passed', 'need(now <= by && by <= now', 'need(by <= now'),
 ('16', "transfer: the not-after has no upper bound (custody's window)", 'need(now <= by && by <= now + le(&g[168..172]) as i64, 4)?;', 'need(now <= by, 4)?;'),
 ('17', 'transfer: the gate end time is ignored', '(!agent || now <= le(&g[160..168]) as i64) && list', 'list'),
 ('18', 'transfer: the agent lane may pay any destination', '&& list.chunks_exact(32).any(|x| x == to);', '&& (agent || list.chunks_exact(32).any(|x| x == to));'),
 ('19', 'transfer: the owners lane may pay any destination', '&& list.chunks_exact(32).any(|x| x == to);', '&& (!agent || list.chunks_exact(32).any(|x| x == to));'),
 ('20', 'transfer: the agent lane may pay the recovery address', '.any(|x| x == to);', '.any(|x| x == to) || to == g[128..160];'),
 ('21', 'transfer: the agent path accepts a source the cap PDA owns (no limit)', '    need(read(src, 32..64)? == gk, 5)?;\n', ''),
 ('22', 'call: any program may be named as the token program', '    need([TOKEN, TOKEN_22].contains(k[0].key), 5)?;\n', ''),
 ('23', 'load: a gate account of another program is accepted', '    need(gate.owner == pid, 5)?;\n', ''),
 ('24', 'allow: one signer may raise the cap', 'w >= if le(&s[121..129]) < le(d) { m } else { 1 }', 'w >= 1'),
 ('25', 'allow: the same cap counts as a raise', 'le(&s[121..129]) < le(d)', 'le(&s[121..129]) <= le(d)'),
 ('26', "allow: the multisig need not be the gate's", 'let ok = ms.key.as_ref() == &g[..32] && w >= if', 'let ok = w >= if'),
 ('27', 'allow: the cap PDA account is not checked', 'let ok = Pubkey::find_program_address(&[b"cap", gk], pid).0 == *cap.key;', 'let ok = true;'),
 ('28', 'allow: a foreign close authority is accepted', 'need(ok && (s[129..133] == [0; 4] || s[133..165] == *gk), 5)?;', 'need(ok, 5)?;'),
 ('29', 'allow: an unset close authority is refused', '(s[129..133] == [0; 4] || s[133..165] == *gk)', 's[133..165] == *gk'),
 ('30', 'release: one signer may release', 'need(ms.key.as_ref() == &g[..32] && w >= m, 1)?;', 'need(ms.key.as_ref() == &g[..32] && w >= 1, 1)?;'),
 ('31', "release: the multisig need not be the gate's", 'need(ms.key.as_ref() == &g[..32] && w >= m, 1)?;', 'need(w >= m, 1)?;'),
 ('32', 'release: the owner changes before the close authority', 'call(a, c(3), &[tok, src, gate], 1, &gs)?;\n    call(a, c(2), &[tok, src, gate], 1, &gs)', 'call(a, c(2), &[tok, src, gate], 1, &gs)?;\n    call(a, c(3), &[tok, src, gate], 1, &gs)'),
 ('33', 'release: only the owner is handed back', '    call(a, c(3), &[tok, src, gate], 1, &gs)?;\n', ''),
 ('34', 'release: only the close authority is handed back', '    call(a, c(2), &[tok, src, gate], 1, &gs)\n}', '    Ok(())\n}'),
 ('35', 'transfer: the destination owner is read from the mint field', 'let to = read(dst, 32..64)?;', 'let to = read(dst, 0..32)?;'),
 ('36', 'transfer: the cap PDA signs with another seed (agent path)', 'let bump = Pubkey::find_program_address(&[b"cap", gk], pid).1;', 'let bump = Pubkey::find_program_address(&[b"cap2", gk], pid).1;'),
 ('37', 'create: the Allocate step is dropped', '    sys(8, &(body.len() as u64).to_le_bytes(), &[gate])?;\n', ''),
 ('38', 'allow: the gate approves its own address as the delegate (the cap PDA is not used)', '&[tok, src, cap, gate], 1,', '&[tok, src, gate, gate], 1,'),
 ('39', 'transfer: the owners lane signs as the cap PDA (bounded by the cap)', '    if !agent {', '    if false {'),
 ('40', 'transfer: the owners lane is stopped by the end time', '(!agent || now <= le(&g[160..168]) as i64)', '(now <= le(&g[160..168]) as i64)'),
 ('41', 'process: a create shorter than its fixed fields reaches create', 'd.len() >= 54 && d.len() % 32 == 22', 'd.len() % 32 == 22'),
 ('42', 'process: a transfer of the wrong length reaches transfer', 'Some((&1, d)) if d.len() == 16 =>', 'Some((&1, d)) =>'),
 ('43', 'process: an allow of the wrong length reaches allow', 'Some((&2, d)) if d.len() == 8 =>', 'Some((&2, d)) =>'),
 ('44', 'process: a release of the wrong length reaches release', 'Some((&3, d)) if d.len() == 32 =>', 'Some((&3, d)) =>'),
 ('45', 'allow: the current cap is read from the balance field', 'le(&s[121..129])', 'le(&s[64..72])'),
 ('46', 'release: the close authority is cleared instead of handed back', '[&[6, k, 1][..], d]', '[&[6, k, 0][..], d]'),
 ('47', 'votes: only the first two signer slots count', 'd[3..].chunks_exact(32)', 'd[3..67].chunks_exact(32)'),
 ('48', 'votes: m and n are read swapped', 'Ok((d[0] as usize, d[1] as usize, w))', 'Ok((d[1] as usize, d[0] as usize, w))'),
 ('49', 'create: the rent top-up transfers nothing', 'sys(2, &rent, &[member, gate])?;', 'sys(2, &[0u8; 8], &[member, gate])?;'),
 ('50', 'create: the Assign step is dropped', '    sys(1, pid.as_ref(), &[gate])?;\n', ''),
 ('51', 'create: the agent lane index is fixed at 1', '[d[52], d[53]].map', '[1, d[53]].map'),
 ('52', 'create: the owners lane index is fixed at 3', '[d[52], d[53]].map', '[d[52], 3].map'),
 ('53', 'transfer: the end time is exclusive (boundary second)', 'now <= le(&g[160..168]) as i64', 'now < le(&g[160..168]) as i64'),
 ('54', 'transfer: a not-after equal to now is refused (boundary second)', 'need(now <= by &&', 'need(now < by &&'),
 ('55', 'le: little-endian numbers are read big-endian', 'b.iter().rev().fold', 'b.iter().fold'),
 ('56', 'call: one account too many is writable', 'is_writable: i <= w,', 'is_writable: i <= w + 1,'),
 ('57', 'call: no account signs', 'is_signer: i + 1 == k.len(),', 'is_signer: i + 1 > k.len(),'),
 ('58', "gate_seeds: the bump is read from the seed's last byte", '&g[180..181]]', '&g[179..180]]'),
 ('59', 'gate_seeds: the seed is read one byte late', '&g[172..180]', '&g[173..181]'),
 ('60', 'load: the last byte of the gate account is dropped', 'read(gate, 0..gate.data_len())', 'read(gate, 0..gate.data_len() - 1)'),
 ('61', 'need: a failed condition passes', 'ok.then_some(())', '(!ok).then_some(())'),
 ('62', 'create: the system calls sign for nothing', 'AccountMeta::new(*x.key, true)', 'AccountMeta::new(*x.key, false)'),
 ('63', 'votes: a token-owned account of any length is accepted as the multisig (a token account posing as custody)', ' && d.len() == 355', '', 'probe'),
 # code the sLOC pass added
 ('64', 'transfer: the owners lane is refused as a lane', 'need(lane.is_signer && (agent || l == &g[96..128]), 1)?;', 'need(lane.is_signer && agent, 1)?;'),
 ('65', 'transfer: the two lanes are taken the wrong way round', 'let agent = l == &g[64..96];', 'let agent = l == &g[96..128];'),
 ('66', 'transfer: the lists of the two lanes are swapped', 'let list = if agent { &g[181..] } else { &g[128..160] };', 'let list = if agent { &g[128..160] } else { &g[181..] };'),
 ('67', 'read: a short account gives another error code', 'ok_or(E::Custom(5))?.to_vec()', 'ok_or(E::Custom(6))?.to_vec()'),
 ('68', 'call: the first key is not the program', '*k[0].key, &d, m)', '*k[1].key, &d, m)'),
 ('69', 'call: the program account is counted among the metas', '.skip(1)', '.skip(0)'),
 ('70', 'create: the stored bump is zero', '[mk, sk, x.as_ref(), y.as_ref(), &d[..52], &bump, &d[54..]]', '[mk, sk, x.as_ref(), y.as_ref(), &d[..52], &[0], &d[54..]]'),
 ('71', 'create: the data is not copied into the gate account', 'Ok(gate.try_borrow_mut_data()?.copy_from_slice(&body))', 'Ok(())'),
 ('72', 'create: the Assign step hands the account to the System program', 'sys(1, pid.as_ref(), &[gate])?;', 'sys(1, &[0; 32], &[gate])?;'),
 ('73', 'create: the Allocate step is one byte short', 'sys(8, &(body.len() as u64).to_le_bytes(), &[gate])?;', 'sys(8, &(body.len() as u64 - 1).to_le_bytes(), &[gate])?;'),
 ('74', 'gate_seeds: the seed prefix is wrong', '[b"gate", &g[..32]', '[b"gat3", &g[..32]'),
 ('75', 'transfer: the token Transfer tag is wrong', 'let data = [&[3][..], &d[..8]].concat();', 'let data = [&[2][..], &d[..8]].concat();'),
 ('76', 'allow: the token Approve tag is wrong', 'let data = [&[4][..], d].concat();', 'let data = [&[3][..], d].concat();'),
 ('77', 'create: the settings key is dropped from the lane vault seeds', '&[SA, sk, SA, &[i]]', '&[SA, mk, SA, &[i]]'),
 ('78', 'create: the stored multisig is the settings key', '[mk, sk, x.as_ref(), y.as_ref(), &d[..52]', '[sk, sk, x.as_ref(), y.as_ref(), &d[..52]'),
]

def mid(m): return f'{P}{m[0]}'

def check():
    src = open(SRC).read(); bad = 0
    for m in M:
        n = src.count(m[2])
        if n != 1: print(mid(m), 'PATTERN', n, repr(m[2][:90])); bad += 1
    print('patterns ok' if not bad else f'{bad} bad patterns', f'({len(M)} mutants)')

def build():
    src = open(SRC).read(); os.makedirs(f'{D}/mut', exist_ok=True)
    env = dict(os.environ, PATH='/home/ubuntu/work/swig-spike/solana-release/bin:' + os.environ['PATH'])
    only = [a for a in sys.argv[2:] if not a.startswith('-')]; bad = 0
    for m in M:
        i = mid(m)
        if only and i not in only: continue
        if os.path.exists(f'{D}/mut/{i}.so') and '-f' not in sys.argv: continue
        if src.count(m[2]) != 1: print(i, 'PATTERN', src.count(m[2])); bad += 1; continue
        open(f'{D}/mut/{i}.rs', 'w').write(src.replace(m[2], m[3]))
        if not os.path.exists(f'{D}/secrets/{i}.json'):
            subprocess.run(['solana-keygen', 'new', '--no-bip39-passphrase', '--silent', '-o', f'{D}/secrets/{i}.json'], env=env, check=True, capture_output=True)
        shutil.copy(f'{D}/mut/{i}.rs', f'{CRATE}/src/lib.rs')
        b = subprocess.run(['cargo-build-sbf', '--offline'], cwd=CRATE, env=env, capture_output=True, text=True)
        if b.returncode != 0: print(i, 'BUILD FAILED', (b.stderr or b.stdout)[-600:]); bad += 1; continue
        shutil.copy(f'{CRATE}/target/deploy/gate.so', f'{D}/mut/{i}.so'); print(i, 'built', flush=True)
    shutil.copy(SRC, f'{CRATE}/src/lib.rs')
    print('done, problems:', bad)

def run_one(m):
    i = mid(m); L = f'{D}/logs/mutants-new'
    env = dict(os.environ, GATE_ID=i, GATE_STOP_ON_FAIL='1', GATE_STATE=f'/tmp/sloc2-mut-{i}.json')
    t0 = time.time()
    with open(f'{L}/{i}.log', 'w') as lf:
        # the mock harness never builds a token account that poses as the multisig, so mutant 63 is judged by the forged-multisig probe (EXPECT_REFUSE=1: the gate must refuse it)
        if len(m) > 4: env['EXPECT_REFUSE'] = '1'
        try: subprocess.run(['bun', 'probe-fakems.ts' if len(m) > 4 else 'gate-a4.ts'], cwd=D, env=env, stdout=lf, stderr=subprocess.STDOUT, timeout=1700)
        except subprocess.TimeoutExpired: pass
    log = open(f'{L}/{i}.log').read()
    fails = re.findall(r'^FAIL (\S+)', log, re.M); tot = re.search(r'(\d+)/(\d+) checks passed', log)
    res = 'killed' if fails else ('CRASHED' if tot is None else 'SURVIVED')
    return (i, m[1], res, ', '.join(fails[:3]), tot.group(0) if tot else 'stopped at the first failure', f'{time.time() - t0:.0f}s')

def run(ids, workers):
    os.makedirs(f'{D}/logs/mutants-new', exist_ok=True)
    todo = [m for m in M if not ids or mid(m) in ids]; rows = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for r in ex.map(run_one, todo):
            rows.append(r); print(r, flush=True)
    out = f'{D}/logs/mutants-new{"-partial" if ids else ""}.md'
    with open(out, 'w') as fh:
        fh.write('| mutant | weakened check | result | first failing check | harness | time |\n|---|---|---|---|---|---|\n')
        for r in rows: fh.write('| ' + ' | '.join(str(x) for x in r) + ' |\n')
    print('killed', sum(r[2] == 'killed' for r in rows), 'of', len(rows))

if __name__ == '__main__':
    a = sys.argv[1:]
    if a[:1] == ['check']: check()
    elif a[:1] == ['build']: build()
    elif a[:1] == ['run']:
        j = 3; rest = a[1:]
        if '-j' in rest: j = int(rest[rest.index('-j') + 1]); rest = [x for x in rest if x not in ('-j', str(j))]
        run(rest, j)
    else: print(__doc__)
