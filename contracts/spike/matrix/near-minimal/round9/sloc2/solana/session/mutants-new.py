#!/usr/bin/env python3
"""Mutation pass for the sLOC pass 2 prime-session (variants/final.rs). Each mutant weakens one check or one piece of the new helpers, is loaded at program A and B of its own validator, and the harness psn.ts
(133 checks, section F included; stub NEAR; mainnet feature set, mainnet Squads) runs against it. A mutant is killed when a check FAILs or the run aborts before its summary line.
  mutants-new.py check             every pattern must occur exactly once
  mutants-new.py build [id...]     builds every mutant into mut/sNN.so
  mutants-new.py run [-j N] [id]   runs them on validators at ports 9181 + 2k; logs in logs/mutants/<id>.log, table in logs/mutants.md"""
import os, re, subprocess, sys, shutil, time, threading
from concurrent.futures import ThreadPoolExecutor
D = os.path.dirname(os.path.abspath(__file__))
SRC = open(f'{D}/variants/final.rs').read(); CRATE = f'{D}/mutcrate'
HDR = '[c, _, 0xffff, k, 0xffff, o, n, 0xffff]'
M = [
 ('01', 'the ed25519 instruction need not be the ed25519 program', 'pre.program_id == ED25519 && ', ''),
 ('02', 'the ed25519 instruction may carry any signature count', 'c % 256 == 1 && ', ''),
 ('03', 'the signature may live in another instruction (index not 0xffff)', HDR, '[c, _, _, k, 0xffff, o, n, 0xffff]'),
 ('04', 'the public key may live in another instruction', HDR, '[c, _, 0xffff, k, _, o, n, 0xffff]'),
 ('05', 'the message may live in another instruction', HDR, '[c, _, 0xffff, k, 0xffff, o, n, _]'),
 ('06', 'the signing key need not be the owner', ' && pre.data.get(k..k + 32) == Some(owner);', ';'),
 ('07', 'the signed message need not be the grant text', 'let ok = ok && pre.data.get(o..o + n) == Some(text.as_bytes());', 'let ok = ok;'),
 ('08', 'the session PDA need not derive from the owner and settings', 'need(ok && pk? == *pda.key, E::Custom(2))?;', 'need(ok, E::Custom(2))?;'),
 ('09', 'a revoked session still works (marker owner not checked)', ' && marker.owner != pid', ''),
 ('10', 'the marker may be any address', 'let ok = m == *marker.key && marker.owner != pid;', 'let ok = marker.owner != pid;'),
 ('11', 'an expired grant works', 'need(now <= until && until <= now + 7 * 86_400, E::Custom(4))?;', 'need(until <= now + 7 * 86_400, E::Custom(4))?;'),
 ('12', 'a grant may last longer than 7 days', 'need(now <= until && until <= now + 7 * 86_400, E::Custom(4))?;', 'need(now <= until, E::Custom(4))?;'),
 ('13', 'the session key need not sign a move', 'need(signer.is_signer || until == 0, E::MissingRequiredSignature)?;', 'need(true, E::MissingRequiredSignature)?;'),
 ('14', 'the PDA does not sign the inner call', 'is_signer: a.key == pda.key || a.is_signer,', 'is_signer: a.is_signer,'),
 ('15', 'the signature instruction is always instruction 0', 'load_instruction_at_checked(sig_ix as usize, ix_sysvar)', 'load_instruction_at_checked(0, ix_sysvar)'),
 ('16', 'a revoke does not assign the marker to the program', 'return sys(1, pid.as_ref(), vec![AccountMeta::new(m, true)]);', 'return Ok(());'),
 ('17', 'a revoke funds the marker below the rent minimum', 'Rent::get()?.minimum_balance(0).to_le_bytes()', '(Rent::get()?.minimum_balance(0) / 2).to_le_bytes()'),
 ('18', 'the inner call goes to the System program', 'Instruction::new_with_bytes(SMART_ACCOUNT, inner, metas)', 'Instruction::new_with_bytes(Pubkey::default(), inner, metas)'),
 ('19', 'the inner call signs with another seed', '    invoke_signed(&ix, a, &[&seeds])\n}', '    invoke_signed(&ix, a, &[&[b"primx", owner, settings, &[bump]]])\n}'),
 ('20', 'every inner account is writable', 'is_writable: a.is_writable,', 'is_writable: true,'),
 ('21', 'a revoke is taken for a move (revoke branch skipped)', 'if until == 0 {', 'if until == 1 {'),
 ('22', 'the grant text omits the session key', 'signer: {}\\nsession key: {}\\nvalid until (unix time): {}\\ncluster: {}",\n        pda.key, signer.key, until, CLUSTER', 'signer: {}\\nvalid until (unix time): {}\\ncluster: {}",\n        pda.key, until, CLUSTER'),
 # code the sLOC pass added
 ('23', 'le: little-endian numbers are read big-endian', 'b.iter().rev().fold', 'b.iter().fold'),
 ('24', 'need: a failed condition passes', 'ok.then_some(())', '(!ok).then_some(())'),
 ('25', 'the key offset and the message offset are swapped', HDR, '[c, _, 0xffff, o, 0xffff, k, n, 0xffff]'),
 ('26', 'the end time is read from the wrong bytes', 'le(&rest[..8]) as i64', 'le(&rest[1..9]) as i64'),
 ('27', 'the signature index and the bump are swapped', '(rest[8], rest[9], &rest[10..])', '(rest[9], rest[8], &rest[10..])'),
 ('28', 'the inner data starts one byte late', '&rest[10..])', '&rest[11..])'),
 ('29', 'a revoke does not flag the rent payer as a signer', 'AccountMeta::new(*tail[0].key, true)', 'AccountMeta::new(*tail[0].key, false)'),
 ('30', 'the transfer data tag is wrong', '[&[tag, 0, 0, 0][..], x]', '[&[tag, 1, 0, 0][..], x]'),
 ('31', 'the PDA seed prefix is wrong', '[b"prime".as_ref(), owner, settings, &[bump]]', '[b"primx".as_ref(), owner, settings, &[bump]]'),
 ('32', 'the marker derives from the PDA instead of the session key', '&[owner, settings, signer.key.as_ref()], pid)', '&[owner, settings, pda.key.as_ref()], pid)'),
 ('33', 'the inner call takes every account, not the tail', 'let metas = tail\n', 'let metas = a\n'),
 ('34', 'a revoke marker is not funded by the payer', 'sys(2, &rent, vec![pay, AccountMeta::new(m, false)])?;', 'sys(2, &rent, vec![AccountMeta::new(m, true), AccountMeta::new(m, false)])?;'),
]
def build():
    os.makedirs(f'{D}/mut', exist_ok=True)
    env = dict(os.environ, PATH='/home/ubuntu/work/swig-spike/solana-release/bin:' + os.environ['PATH'], PRIME_CLUSTER='localnet')
    only = [a for a in sys.argv[2:] if not a.startswith('-')]
    for mid, desc, old, new in M:
        if only and f's{mid}' not in only: continue
        if os.path.exists(f'{D}/mut/s{mid}.so') and '-f' not in sys.argv: continue
        if SRC.count(old) != 1: print(mid, 'PATTERN', SRC.count(old), repr(old[:70])); continue
        open(f'{CRATE}/src/lib.rs', 'w').write(SRC.replace(old, new))
        b = subprocess.run(['cargo-build-sbf', '--offline'], cwd=CRATE, env=env, capture_output=True, text=True)
        if b.returncode != 0: print(mid, 'BUILD FAILED', (b.stderr or b.stdout)[-500:]); continue
        shutil.copy(f'{CRATE}/target/deploy/prime_session.so', f'{D}/mut/s{mid}.so'); print(mid, 'built', flush=True)
    open(f'{CRATE}/src/lib.rs', 'w').write(SRC)

ports = [9181, 9183, 9185, 9187, 9189, 9191]; lock = threading.Lock(); free = list(ports)

def run_one(m):
    mid = f's{m[0]}'
    with lock: port = free.pop()
    os.makedirs(f'{D}/logs/mutants', exist_ok=True)
    env = dict(os.environ, VPORT=str(port), SO=f'{D}/mut/{mid}.so', PSN_RPC=f'http://127.0.0.1:{port}', PSN_STATE=f'/tmp/sloc2-smut-{mid}.json', NEARSIG_STUB='/home/ubuntu/work/metamask-sol/stub/nearsig-stub.ts')
    t0 = time.time()
    try:
        subprocess.run(['./run-validator.sh'], cwd=D, env=env, capture_output=True, timeout=300)
        with open(f'{D}/logs/mutants/{mid}.log', 'w') as lf:
            try: subprocess.run(['bun', os.environ.get('PSN_SCRIPT', 'psn.ts')], cwd=D, env=env, stdout=lf, stderr=subprocess.STDOUT, timeout=900)
            except subprocess.TimeoutExpired: pass
    finally:
        subprocess.run(['./stop-validator.sh'], cwd=D, env=env, capture_output=True)
        with lock: free.append(port)
    log = open(f'{D}/logs/mutants/{mid}.log').read()
    fails = re.findall(r'^FAIL (\S+)', log, re.M); tot = re.search(r'^(\d+)/(\d+) passed', log, re.M)
    res = 'killed' if fails else ('killed (run aborted)' if tot is None else 'SURVIVED')
    return (mid, m[1], res, ', '.join(fails[:3]), tot.group(0) if tot else 'no summary', f'{time.time() - t0:.0f}s')

def run(ids, workers):
    todo = [m for m in M if not ids or f's{m[0]}' in ids]; rows = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for r in ex.map(run_one, todo): rows.append(r); print(r, flush=True)
    with open(f'{D}/logs/mutants{"-partial" if ids else ""}.md', 'w') as f:
        f.write('| mutant | weakened check | result | failing checks (first three) | harness | time |\n|---|---|---|---|---|---|\n')
        for r in rows: f.write('| ' + ' | '.join(str(x) for x in r) + ' |\n')
    print('killed', sum(r[2].startswith('killed') for r in rows), 'of', len(rows))

if __name__ == '__main__':
    a = sys.argv[1:]
    if a and a[0] == 'check':
        bad = [m[0] for m in M if SRC.count(m[2]) != 1]; print('bad patterns:', bad or 'none', f'({len(M)} mutants)')
    elif a and a[0] == 'build': build()
    elif a and a[0] == 'run':
        j = 3; rest = a[1:]
        if '-j' in rest: j = int(rest[rest.index('-j') + 1]); rest = [x for x in rest if x not in ('-j', str(j))]
        run(rest, j)
    else: print(__doc__)
