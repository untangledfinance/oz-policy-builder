#!/usr/bin/env python3
"""Prints sLOC (as written and after rustfmt), .so sizes, deploy rent and the CU and bytes per move from the state files of a run."""
import json, os, subprocess, sys
D = os.path.dirname(os.path.abspath(__file__))
SLOC = '/home/ubuntu/work/prime-refine/logs/sol-min/sloc.py'
RATE = 6960   # lamports per byte-year for two years: the rent-exempt minimum is (data length + 128) * 6960
def rent(n): return (n + 128) * RATE
def deploy(n): return rent(n + 45) + rent(36)   # program-data account (45-byte header) plus the program account
print('--- sLOC (as written, after rustfmt)')
subprocess.run(['python3', SLOC] + [f'{D}/variants/{f}' for f in sorted(os.listdir(f'{D}/variants'))])
print('--- binaries and deploy rent (program-data + program account)')
for f in sorted(os.listdir(f'{D}/so')):
    if f.endswith('.so'):
        n = os.path.getsize(f'{D}/so/{f}'); print(f'{f:24s} {n:7d} B  {deploy(n):12d} lamports  {deploy(n)/1e9:.3f} SOL')
n = os.path.getsize(f'{D}/fixtures/prime_session.so'); print(f'{"prime_session.so":24s} {n:7d} B  {deploy(n):12d} lamports  {deploy(n)/1e9:.3f} SOL')
for p in sys.argv[1:]:
    st = json.load(open(p)); print(f'--- costs from {os.path.basename(p)}')
    for k, v in st['costs'].items():
        s = v.get('samples')
        if s:
            med = lambda xs: sorted(xs)[len(xs) // 2]
            print(f'{k:72s} {med([x["cu"] for x in s]):>8} CU {med([x["bytes"] for x in s]):>6} B gate {med([x.get("gateCu") or 0 for x in s]):>6} CU (n={len(s)})')
        else: print(f'{k:72s} {json.dumps(v)}')
