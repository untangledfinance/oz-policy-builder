#!/usr/bin/env python3
# Prints the numbers the report quotes, from the state file of a run.
import json, re, sys, collections
st = json.load(open(sys.argv[1] if len(sys.argv) > 1 else '/home/ubuntu/work/seat-spike/stellar/state-sst.json'))
r = st['results']
g = collections.OrderedDict()
for k, v in r.items():
    grp = re.match(r'^([A-Z]+)', k).group(1)
    a = g.setdefault(grp, [0, 0]); a[0] += 1; a[1] += 1 if v['pass'] else 0
print('GROUPS', {k: f'{b}/{a}' for k, (a, b) in g.items()})
print('TOTAL', sum(a for a, _ in g.values()), 'passed', sum(b for _, b in g.values()))
print('FAILS', [k for k, v in r.items() if not v['pass']])
print('DEPLOY', {k: st.get(k) for k in ['prime', 'prime2', 'S_mm', 'S_fr', 'S_ph', 'P_base', 'venue', 'wasm', 'wasmSha256', 'wasmTx', 'S_mmTx', 'S_frTx', 'S_phTx', 'primeTx', 'prime2Tx', 'P_baseTx', 'G_mm', 'G_fr', 'G_ph', 'r_probe', 'r_mm', 'r_fr', 'r_ph', 'r_base', 'r2_probe', 'r2_ops']})
fees = collections.defaultdict(list); cpu = collections.defaultdict(list)
for k, v in r.items():
    if v.get('fee') is not None and v.get('ok'):
        key = f"{v['kind']} {'self-paid' if v.get('selfPaid') else 'relayed'}"
        fees[key].append(v['fee'])
        if v.get('cpu'): cpu[key].append(v['cpu'])
for k, l in sorted(fees.items()):
    l.sort(); c = sorted(cpu.get(k, []))
    print(f"FEE {k:34} n={len(l):3} min={l[0]:8} med={l[len(l)//2]:8} max={l[-1]:8} cpuMed={c[len(c)//2] if c else '-'}")
