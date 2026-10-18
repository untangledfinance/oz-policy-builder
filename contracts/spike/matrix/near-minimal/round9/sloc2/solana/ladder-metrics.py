#!/usr/bin/env python3
"""ladder-metrics.py <gate|session>: re-runs the ladder (from r00) and prints, per rung, the formatted sLOC, the as-written sLOC of the cut text before rustfmt, and the token count of the code (comments stripped)."""
import re, subprocess, sys, os
kind = sys.argv[1]
base = '/home/ubuntu/work/sloc2/solana/' + kind + '/ladder'
os.chdir(base)
src = open('rungs2.py' if kind == 'gate' else 'rungs.py').read()
main_at = src.rindex("if __name__ == '__main__':")
ns = {'__name__': 'ladder', '__file__': base + '/x.py'}
exec(src[:main_at], ns)
TOK = re.compile(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])\'|\'[a-z_]+|0x[0-9a-fA-F_]+|\d[\d_]*|[A-Za-z_]\w*!?|::|\.\.=?|=>|->|[=!<>]=|&&|\|\||<<|>>|[-+*/%&|^]=|\S')
def tokens(path):
    code = '\n'.join(l for l in open(path).read().splitlines() if not l.strip().startswith('//'))
    return len(TOK.findall(code))
rows = []
pre = {}
real_fmt = ns['fmt']
def fmt(p):
    pre[os.path.basename(p)] = ns['sloc'](p); real_fmt(p)
ns['fmt'] = fmt
import io, contextlib
titles = (ns['titles'] + ns.get('titles2', [])) if kind == 'gate' else ns['titles']
fs = (ns['rs'] + ns.get('rs2', [])) if kind == 'gate' else ns['rs']
prev_s, prev_t = ns['sloc']('r00.rs'), tokens('r00.rs')
print(f'| rung | cut | formatted sLOC | formatted delta | as-written delta | tokens delta | kind |\n|---|---|---|---|---|---|---|')
print(f'| r00 | original after rustfmt | {prev_s} | | | {prev_t} tokens | |')
for i, (f, ti) in enumerate(zip(fs, titles), 1):
    with contextlib.redirect_stdout(io.StringIO()): ns['rung'](i, ti, f)
    p = f'r{i:02d}.rs'; s, t = ns['sloc'](p), tokens(p)
    aw = pre[p] - prev_s; ds, dt = s - prev_s, t - prev_t
    k = 'logic removed' if dt < -2 else ('shape only' if ds < 0 else 'neutral')
    print(f'| r{i:02d} | {ti} | {s} | {ds:+d} | {aw:+d} | {dt:+d} | {k} |')
    prev_s, prev_t = s, t
