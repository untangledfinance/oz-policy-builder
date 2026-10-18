#!/usr/bin/env python3
"""Mutation pass for the today's prime-session (today/src/lib.rs). Each mutant weakens one check, is loaded at program A and B of its own validator, and the unchanged harness copy psn.ts runs against it
(stub NEAR; mainnet feature set, mainnet Squads). A mutant is killed when a check FAILs or the run aborts before its summary line.
  mutants.py build            builds every mutant into mut/sNN.so
  mutants.py run [-j N] [id]  runs them on validators at ports 9121 + 2k; logs in logs/mutants/<id>.log, table in logs/mutants.md"""
import os, re, subprocess, sys, shutil, time, threading
from concurrent.futures import ThreadPoolExecutor
D = os.path.dirname(os.path.abspath(__file__))
SRC = open(f'{D}/today/src/lib.rs').read()
M = [
 ('01', 'the ed25519 instruction need not be the ed25519 program', 'pre.program_id == ED25519 && ', ''),
 ('02', 'the ed25519 instruction may carry any signature count', ' && d.first() == Some(&1)', ''),
 ('03', 'the signature may live in another instruction (index not 0xffff)', '[u(4), u(8), u(14)]', '[u(8), u(14)]'),
 ('04', 'the public key may live in another instruction', '[u(4), u(8), u(14)]', '[u(4), u(14)]'),
 ('05', 'the message may live in another instruction', '[u(4), u(8), u(14)]', '[u(4), u(8)]'),
 ('06', 'the signing key need not be the owner', 'signed != Some((owner, text.as_bytes()))', 'signed.map(|x| x.1) != Some(text.as_bytes())'),
 ('07', 'the signed message need not be the grant text', 'signed != Some((owner, text.as_bytes()))', 'signed.map(|x| x.0) != Some(owner)'),
 ('08', 'the session PDA need not derive from the owner and settings', ' || Pubkey::create_program_address(&[b"prime", owner, settings, &[bump]], program_id)? != *pda.key', ''),
 ('09', 'a revoked session still works (marker owner not checked)', ' || marker.owner == program_id', ''),
 ('10', 'the marker may be any address', 'm != *marker.key || ', ''),
 ('11', 'an expired grant works', 'now > until || ', ''),
 ('12', 'a grant may last longer than 7 days', ' || until > now + 7 * 86_400', ''),
 ('13', 'the session key need not sign a move', 'if !signer.is_signer && until != 0 {', 'if false {'),
 ('14', 'the PDA does not sign the inner call', 'a.key == pda.key || a.is_signer', 'a.is_signer'),
 ('15', 'the signature instruction is always instruction 0', 'load_instruction_at_checked(sig_ix as usize, ix_sysvar)', 'load_instruction_at_checked(0, ix_sysvar)'),
 ('16', 'a revoke does not assign the marker to the program', 'return sys(&[&[1, 0, 0, 0][..], program_id.as_ref()].concat(), vec![AccountMeta::new(m, true)]);', 'return Ok(());'),
 ('17', 'a revoke funds the marker below the rent minimum', 'Rent::get()?.minimum_balance(0).to_le_bytes()', '(Rent::get()?.minimum_balance(0) / 2).to_le_bytes()'),
 ('18', 'the inner call goes to the System program', 'program_id: SMART_ACCOUNT', 'program_id: Pubkey::default()'),
 ('19', 'the inner call signs with another seed', 'accounts, &[&[b"prime", owner, settings, &[bump]]])', 'accounts, &[&[b"primx", owner, settings, &[bump]]])'),
 ('20', 'every inner account is writable', 'is_writable: a.is_writable }', 'is_writable: true }'),
 ('21', 'a revoke is taken for a move (revoke branch skipped)', 'if until == 0 {', 'if until == 1 {'),
 ('22', 'the grant text omits the session key', 'signer: {}\\nsession key: {}\\nvalid until (unix time): {}\\ncluster: {}", pda.key, key, until, CLUSTER', 'signer: {}\\nvalid until (unix time): {}\\ncluster: {}", pda.key, until, CLUSTER'),
]

def build():
    os.makedirs(f'{D}/mut', exist_ok=True)
    env = dict(os.environ, PATH='/home/ubuntu/work/swig-spike/solana-release/bin:' + os.environ['PATH'], PRIME_CLUSTER='localnet')
    only = [a for a in sys.argv[2:] if not a.startswith('-')]
    for mid, desc, old, new in M:
        if only and f's{mid}' not in only: continue
        if SRC.count(old) != 1: print(mid, 'PATTERN', SRC.count(old), repr(old[:70])); continue
        open(f'{D}/today/src/lib.rs', 'w').write(SRC.replace(old, new))
        b = subprocess.run(['cargo-build-sbf', '--offline'], cwd=f'{D}/today', env=env, capture_output=True, text=True)
        open(f'{D}/today/src/lib.rs', 'w').write(SRC)
        if b.returncode != 0: print(mid, 'BUILD FAILED', (b.stderr or b.stdout)[-500:]); continue
        shutil.copy(f'{D}/today/target/deploy/prime_session.so', f'{D}/mut/s{mid}.so'); print(mid, 'built', flush=True)
    subprocess.run(['cargo-build-sbf', '--offline'], cwd=f'{D}/today', env=env, capture_output=True)   # leave the real build in target/

ports = [9121, 9123, 9125, 9127, 9129, 9131]; lock = threading.Lock(); free = list(ports)

def run_one(m):
    mid = f's{m[0]}'
    with lock: port = free.pop()
    os.makedirs(f'{D}/logs/mutants', exist_ok=True)
    env = dict(os.environ, VPORT=str(port), SO=f'{D}/mut/{mid}.so', PSN_RPC=f'http://127.0.0.1:{port}', PSN_STATE=f'/tmp/opt-smut-{mid}.json', NEARSIG_STUB='/home/ubuntu/work/metamask-sol/stub/nearsig-stub.ts')
    t0 = time.time()
    try:
        subprocess.run(['./run-validator.sh'], cwd=D, env=env, capture_output=True, timeout=300)
        with open(f'{D}/logs/mutants/{mid}{os.environ.get("PSN_TAG", "")}.log', 'w') as lf:
            try: subprocess.run(['bun', os.environ.get('PSN_SCRIPT', 'psn.ts')], cwd=D, env=env, stdout=lf, stderr=subprocess.STDOUT, timeout=600)
            except subprocess.TimeoutExpired: pass
    finally:
        subprocess.run(['./stop-validator.sh'], cwd=D, env=env, capture_output=True)
        with lock: free.append(port)
    log = open(f'{D}/logs/mutants/{mid}{os.environ.get("PSN_TAG", "")}.log').read()
    fails = re.findall(r'^FAIL (\S+)', log, re.M); tot = re.search(r'^(\d+)/(\d+) passed', log, re.M)
    res = 'killed' if fails else ('killed (run aborted)' if tot is None else 'SURVIVED')
    return (mid, m[1], res, ', '.join(fails[:3]), tot.group(0) if tot else 'no summary', f'{time.time() - t0:.0f}s')

def run(ids, workers):
    todo = [m for m in M if not ids or f's{m[0]}' in ids]; rows = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for r in ex.map(run_one, todo): rows.append(r); print(r, flush=True)
    with open(f'{D}/logs/mutants{os.environ.get("PSN_TAG", "")}{"-partial" if ids else ""}.md', 'w') as f:
        f.write('| mutant | weakened check | result | failing checks (first three) | harness | time |\n|---|---|---|---|---|---|\n')
        for r in rows: f.write('| ' + ' | '.join(str(x) for x in r) + ' |\n')
    print('killed', sum(r[2].startswith('killed') for r in rows), 'of', len(rows))

if __name__ == '__main__':
    a = sys.argv[1:]
    if a and a[0] == 'build': build()
    elif a and a[0] == 'run':
        j = 3; rest = a[1:]
        if '-j' in rest: j = int(rest[rest.index('-j') + 1]); rest = [x for x in rest if x not in ('-j', str(j))]
        run(rest, j)
    else: print(__doc__)
