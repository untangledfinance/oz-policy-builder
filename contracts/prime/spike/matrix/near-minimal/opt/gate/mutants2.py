#!/usr/bin/env python3
"""Mutation pass for the line-cut gate (variants/gate-lc.rs, flavour lc; variants/gate-lc-msfix.rs with the multisig length check, flavour lcfix) and its Pinocchio port (variants/gate-pino.rs, flavour pino).
Each mutant weakens exactly one check; the same table drives both flavours (the Pinocchio text differs only in accessor syntax, which tr() translates; a few entries carry their own pino pattern).
  mutants2.py <lc|lcfix|pino> build            builds every mutant into mut/<prefix><nn>.so (+ .rs) and makes secrets/<id>.json
  mutants2.py <lc|pino> run [-j N] [id]  runs the whole mock-venue harness (gate-a4.ts) against each mutant, GATE_STOP_ON_FAIL=1, on the validator at GATE_RPC (start it with MUTANTS=1 MUTSET=<prefix>).
A mutant is killed when a check fails; logs go to logs/mutants-<flavour>/<id>.log and the table to logs/mutants-<flavour>.md."""
import os, re, subprocess, sys, time, shutil
from concurrent.futures import ThreadPoolExecutor
D = os.path.dirname(os.path.abspath(__file__))
FLAV = {'lc': dict(src='variants/gate-lc.rs', prefix='l', crate=f'{D}/gate'), 'lcfix': dict(src='variants/gate-lc-msfix.rs', prefix='f', crate=f'{D}/gate'), 'pino': dict(src='variants/gate-pino.rs', prefix='p', crate=f'{D}/../gate-pino')}

def tr(s):  # lc text -> pino text
    s = re.sub(r'\.key\b(?!\()', '.key()', s); s = re.sub(r'\.owner\b(?!\()', '.owner()', s); s = re.sub(r'\.is_signer\b(?!\()', '.is_signer()', s)
    return s.replace('Pubkey::find_program_address(', 'find_program_address(')

# (suffix, description, old, new[, pino old, pino new])
M = [
 ('01', 'create: both lanes may be the same vault', 'd[52] != d[53] && d[52] != 0', 'd[52] != 0'),
 ('02', 'create: agent lane 0 (where session rules sign) is accepted', 'd[52] != d[53] && d[52] != 0 && d[53] != 0', 'd[52] != d[53] && d[53] != 0'),
 ('03', 'create: owners lane 0 is accepted', 'd[52] != 0 && d[53] != 0 =>', 'd[52] != 0 =>'),
 ('04', 'create: the destination list need not be whole 32-byte entries', ' && d.len() % 32 == 22', ''),
 ('05', 'create: the signer need not be a signer of the multisig', 'need(w >= 1 && m <= n', 'need(m <= n'),
 ('06', 'create: a multisig with m greater than n is accepted', ' && m <= n && settings.owner', ' && settings.owner'),
 ('07', 'create: the settings account need not be owned by Squads', ' && settings.owner == &SQUADS', ''),
 ('08', 'create: a Prime Account with a settings authority is accepted', ' && read(settings, 24..56)? == [0; 32]', ''),
 ('09', 'votes: the identity need not belong to a token program', '    need(TOKEN.contains(ms.owner), 5)?;\n', ''),
 ('10', 'votes: a key counts although it did not sign', 'x.is_signer && ', ''),
 ('11', 'create: the seed is not part of the gate address', 'settings.key.as_ref(), &d[44..52]];', 'settings.key.as_ref(), &d[0..0]];'),
 ('12', 'create: the two lane vaults are stored swapped', 'vault(d[52]).as_ref(), vault(d[53]).as_ref()', 'vault(d[53]).as_ref(), vault(d[52]).as_ref()'),
 ('13', 'transfer: the lane need not sign', 'need(lane.is_signer && (agent || owners), 1)?;', 'need(agent || owners, 1)?;'),
 ('14', 'transfer: any signer counts as a lane', 'need(lane.is_signer && (agent || owners), 1)?;', 'need(lane.is_signer, 1)?;'),
 ('15', 'transfer: the not-after may have passed', 'need(now <= by && by <= now', 'need(by <= now'),
 ('16', "transfer: the not-after has no upper bound (custody's window)", 'need(now <= by && by <= now + le(&g[168..172]) as i64, 4)?;', 'need(now <= by, 4)?;'),
 ('17', 'transfer: the gate end time is ignored', 'now <= le(&g[160..168]) as i64 && g[181..]', 'g[181..]'),
 ('18', 'transfer: the agent lane may pay any destination', ' && g[181..].chunks_exact(32).any(|x| x == to)', ''),
 ('19', 'transfer: the owners lane may pay any destination', 'else { to == g[128..160] }', 'else { true }'),
 ('20', 'transfer: the agent lane may pay the recovery address', '.any(|x| x == to) }', '.any(|x| x == to) || to == g[128..160] }'),
 ('21', 'transfer: the agent path accepts a source the cap PDA owns (no limit)', '    need(read(src, 32..64)? == gate.key.as_ref(), 5)?;\n', ''),
 ('22', 'call: any program may be named as the token program', '    need(TOKEN.contains(tok.key), 5)?;\n', ''),
 ('23', 'load: a gate account of another program is accepted', '    need(gate.owner == pid, 5)?;\n', ''),
 ('24', 'allow: one signer may raise the cap', 'w >= if le(&s[121..129]) < le(d) { m } else { 1 }', 'w >= 1'),
 ('25', 'allow: the same cap counts as a raise', 'le(&s[121..129]) < le(d)', 'le(&s[121..129]) <= le(d)'),
 ('26', "allow: the multisig need not be the gate's", 'need(ms.key.as_ref() == &g[..32] && w >= if', 'need(w >= if'),
 ('27', 'allow: the cap PDA account is not checked', 'Pubkey::find_program_address(&[b"cap", gate.key.as_ref()], pid).0 == *cap.key && (s[129..133]', '(s[129..133]'),
 ('28', 'allow: a foreign close authority is accepted', ' && (s[129..133] == [0; 4] || s[133..165] == *gate.key.as_ref())', ''),
 ('29', 'allow: an unset close authority is refused', '(s[129..133] == [0; 4] || s[133..165] == *gate.key.as_ref())', 's[133..165] == *gate.key.as_ref()'),
 ('30', 'release: one signer may release', 'need(ms.key.as_ref() == &g[..32] && w >= m, 1)?;\n    [3, 2]', 'need(ms.key.as_ref() == &g[..32] && w >= 1, 1)?;\n    [3, 2]'),
 ('31', "release: the multisig need not be the gate's", 'need(ms.key.as_ref() == &g[..32] && w >= m, 1)?;', 'need(w >= m, 1)?;'),
 ('32', 'release: the owner changes before the close authority', '[3, 2].iter()', '[2, 3].iter()'),
 ('33', 'release: only the owner is handed back', '[3, 2].iter()', '[2].iter()'),
 ('34', 'release: only the close authority is handed back', '[3, 2].iter()', '[3].iter()'),
 ('35', 'transfer: the destination owner is read from the mint field', 'let to = read(dst, 32..64)?;', 'let to = read(dst, 0..32)?;'),
 ('36', 'transfer: the cap PDA signs with another seed (agent path)', 'let bump = Pubkey::find_program_address(&[b"cap", gate.key.as_ref()], pid).1;', 'let bump = Pubkey::find_program_address(&[b"cap2", gate.key.as_ref()], pid).1;'),
 ('37', 'create: the Allocate step is dropped', '    sys(8, &(body.len() as u64).to_le_bytes(), &[gate])?;\n', ''),
 ('38', 'allow: the gate approves its own address as the delegate (the cap PDA is not used)', '&[src, cap, gate], 1, &gate_seeds(&g))', '&[src, gate, gate], 1, &gate_seeds(&g))'),
 ('39', 'transfer: the owners lane signs as the cap PDA (bounded by the cap)', 'if owners { return call(', 'if false { return call('),
 ('40', 'transfer: the owners lane is stopped by the end time', 'else { to == g[128..160] }', 'else { to == g[128..160] && now <= le(&g[160..168]) as i64 }'),
 ('41', 'process: a create shorter than its fixed fields reaches create', 'd.len() >= 54 && d.len() % 32 == 22', 'd.len() % 32 == 22'),
 ('42', 'process: a transfer of the wrong length reaches transfer', 'Some((&1, d)) if d.len() == 16 =>', 'Some((&1, d)) =>'),
 ('43', 'process: an allow of the wrong length reaches allow', 'Some((&2, d)) if d.len() == 8 =>', 'Some((&2, d)) =>'),
 ('44', 'process: a release of the wrong length reaches release', 'Some((&3, d)) if d.len() == 32 =>', 'Some((&3, d)) =>'),
 ('45', 'allow: the current cap is read from the balance field', 'le(&s[121..129])', 'le(&s[64..72])'),
 ('46', 'release: the close authority is cleared instead of handed back', '[6, *kind, 1]', '[6, *kind, 0]'),
 ('47', 'votes: only the first two signer slots count', 'd[3..].chunks_exact(32)', 'd[3..67].chunks_exact(32)'),
 ('48', 'votes: m and n are read swapped', 'Ok((d[0] as usize, d[1] as usize, w))', 'Ok((d[1] as usize, d[0] as usize, w))'),
 ('49', 'create: the rent top-up transfers nothing', 'sys(2, &Rent::get()?.minimum_balance(body.len()).to_le_bytes(), &[member, gate])?;', 'sys(2, &[0u8; 8], &[member, gate])?;'),
 ('50', 'create: the Assign step is dropped', '    sys(1, pid.as_ref(), &[gate])?;\n', '', '    sys(1, pid, &[gate])?;\n', ''),
 ('51', 'create: the agent lane index is fixed at 1', 'vault(d[52]).as_ref()', 'vault(1).as_ref()'),
 ('52', 'create: the owners lane index is fixed at 3', 'vault(d[53]).as_ref()', 'vault(3).as_ref()'),
 ('53', 'transfer: the end time is exclusive (boundary second)', 'now <= le(&g[160..168]) as i64', 'now < le(&g[160..168]) as i64'),
 ('54', 'transfer: a not-after equal to now is refused (boundary second)', 'need(now <= by &&', 'need(now < by &&'),
 # code the line cuts introduced
 ('55', 'le: little-endian numbers are read big-endian', 'b.iter().rev().fold', 'b.iter().fold'),
 ('56', 'cpi: one account too many is writable', 'is_writable: i < w', 'is_writable: i <= w', 'i < w, i + s >= keys.len()', 'i <= w, i + s >= keys.len()'),
 ('57', 'cpi: no account signs', 'is_signer: i + s >= keys.len()', 'is_signer: i + s > keys.len()', 'i < w, i + s >= keys.len()', 'i < w, i + s > keys.len()'),
 ('58', "gate_seeds: the bump is read from the seed's last byte", '&g[180..181]]', '&g[179..180]]'),
 ('59', 'gate_seeds: the seed is read one byte late', '&g[172..180]', '&g[173..181]'),
 ('60', 'load: the last byte of the gate account is dropped', 'read(gate, 0..gate.data_len())', 'read(gate, 0..gate.data_len() - 1)'),
 ('61', 'need: a failed condition passes', 'ok.then_some(())', '(!ok).then_some(())'),
 ('62', 'create: the system calls sign for nothing (system call signer count 0)', 'keys, keys.len(), keys.len(), &[seeds[0]', 'keys, keys.len(), 0, &[seeds[0]'),
 # lcfix only: the multisig length check
 ('63', 'votes: a token-owned account of any length is accepted as the multisig (a token account posing as custody)', ' && d.len() == 355', ''),
]

def pino_pair(m):
    if len(m) > 4: return m[4], m[5]
    return tr(m[2]), tr(m[3])

def mutant(flavour, m, src):
    if flavour == 'lc': return m[2], m[3]
    if flavour == 'lcfix': return m[2].replace('need(TOKEN.contains(ms.owner), 5)', 'need(TOKEN.contains(ms.owner) && d.len() == 355, 5)'), m[3]
    return pino_pair(m)

def applicable(flavour):  # mutant 63 removes the length check, which only the lcfix source has
    return [m for m in M if m[0] != '63' or flavour == 'lcfix']

def build(flavour):
    f = FLAV[flavour]; src = open(f'{D}/{f["src"]}').read(); os.makedirs(f'{D}/mut', exist_ok=True)
    env = dict(os.environ, PATH='/home/ubuntu/work/swig-spike/solana-release/bin:' + os.environ['PATH'])
    only = [a for a in sys.argv[3:] if not a.startswith('-')]
    bad = 0
    for m in applicable(flavour):
        mid = f'{f["prefix"]}{m[0]}'
        if only and mid not in only: continue
        if os.path.exists(f'{D}/mut/{mid}.so') and '-f' not in sys.argv: continue
        old, new = mutant(flavour, m, src)
        if src.count(old) != 1: print(mid, 'PATTERN', src.count(old), repr(old[:80])); bad += 1; continue
        open(f'{D}/mut/{mid}.rs', 'w').write(src.replace(old, new))
        if not os.path.exists(f'{D}/secrets/{mid}.json'):
            subprocess.run(['solana-keygen', 'new', '--no-bip39-passphrase', '--silent', '-o', f'{D}/secrets/{mid}.json'], env=env, check=True, capture_output=True)
        shutil.copy(f'{D}/mut/{mid}.rs', f'{f["crate"]}/src/lib.rs')
        b = subprocess.run(['cargo-build-sbf', '--offline'], cwd=f['crate'], env=env, capture_output=True, text=True)
        if b.returncode != 0: print(mid, 'BUILD FAILED', (b.stderr or b.stdout)[-600:]); bad += 1; continue
        shutil.copy(f'{f["crate"]}/target/deploy/gate.so', f'{D}/mut/{mid}.so'); print(mid, 'built', flush=True)
    print('done, problems:', bad)

def run_one(flavour, m):
    f = FLAV[flavour]; mid = f'{f["prefix"]}{m[0]}'; L = f'{D}/logs/mutants-{flavour}'
    env = dict(os.environ, GATE_ID=mid, GATE_STOP_ON_FAIL='1', GATE_STATE=f'/tmp/opt-mut-{mid}.json')
    t0 = time.time()
    with open(f'{L}/{mid}.log', 'w') as lf:
        # the mock harness never builds a token account that poses as the multisig, so mutant 63 is judged by the forged-multisig probe (EXPECT_REFUSE=1: the gate must refuse it)
        if flavour == 'lcfix' and m[0] == '63': env['EXPECT_REFUSE'] = '1'
        try: subprocess.run(['bun', 'probe-fakems.ts' if env.get('EXPECT_REFUSE') else 'gate-a4.ts'], cwd=D, env=env, stdout=lf, stderr=subprocess.STDOUT, timeout=1700)
        except subprocess.TimeoutExpired: pass
    log = open(f'{L}/{mid}.log').read()
    fails = re.findall(r'^FAIL (\S+)', log, re.M); tot = re.search(r'(\d+)/(\d+) checks passed', log)
    res = 'killed' if fails else ('CRASHED' if tot is None else 'SURVIVED')
    return (mid, m[1], res, ', '.join(fails[:3]), tot.group(0) if tot else 'stopped at the first failure', f'{time.time() - t0:.0f}s')

def run(flavour, ids, workers):
    f = FLAV[flavour]; os.makedirs(f'{D}/logs/mutants-{flavour}', exist_ok=True)
    todo = [m for m in applicable(flavour) if not ids or f'{f["prefix"]}{m[0]}' in ids]
    rows = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for r in ex.map(lambda m: run_one(flavour, m), todo):
            rows.append(r); print(r, flush=True)
    out = f'{D}/logs/mutants-{flavour}{"-partial" if ids else ""}.md'
    with open(out, 'w') as fh:
        fh.write('| mutant | weakened check | result | first failing check | harness | time |\n|---|---|---|---|---|---|\n')
        for r in rows: fh.write('| ' + ' | '.join(str(x) for x in r) + ' |\n')
    print('killed', sum(r[2] == 'killed' for r in rows), 'of', len(rows))

if __name__ == '__main__':
    a = sys.argv[1:]
    if len(a) >= 2 and a[0] in FLAV and a[1] == 'build': build(a[0])
    elif len(a) >= 2 and a[0] in FLAV and a[1] == 'run':
        j = 3; rest = a[2:]
        if '-j' in rest: j = int(rest[rest.index('-j') + 1]); rest = [x for x in rest if x not in ('-j', str(j))]
        run(a[0], rest, j)
    else: print(__doc__)
