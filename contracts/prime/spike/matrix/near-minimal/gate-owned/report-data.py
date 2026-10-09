#!/usr/bin/env python3
"""Prints the tables of the report from the final logs: checks per section, costs per move, the mutation table."""
import ast, json, os, re, sys
D = '/home/ubuntu/work/prime-refine/logs/gate/a4'
def counts(path):
    c = {}
    for l in open(path, errors='replace'):
        m = re.match(r'^(PASS|FAIL) ([A-Z]+)\d', l)
        if m: sec = m.group(2); c.setdefault(sec, [0, 0]); c[sec][0 if m.group(1) == 'PASS' else 1] += 1
    return c
def costs(path):
    st = json.load(open(path)); out = {}
    for k, v in st['costs'].items():
        s = v.get('samples')
        if s:
            med = lambda xs: sorted(xs)[len(xs) // 2]
            out[k] = (med([x['cu'] for x in s]), med([x['bytes'] for x in s]), med([x.get('gateCu') or 0 for x in s]), len(s))
        else: out[k] = v
    return out
def mut(path):
    rows = []
    for l in open(path):
        if l.startswith("('"): rows.append(ast.literal_eval(l.strip()))
    return rows
if __name__ == '__main__':
    what = sys.argv[1]
    if what == 'counts':
        for p in sys.argv[2:]:
            c = counts(p); print(p, sum(v[0] for v in c.values()), 'pass', sum(v[1] for v in c.values()), 'fail'); print(' '.join(f'{k}:{v[0]}/{v[0]+v[1]}' for k, v in c.items()))
    elif what == 'costs':
        for k, v in costs(sys.argv[2]).items(): print(f'{k} | {v}')
    elif what == 'mut':
        rows = mut(sys.argv[2]); print(len(rows), 'mutants', sum(1 for r in rows if r[2] == 'killed'), 'killed')
        for r in rows: print(f'| {r[0]} | {r[1]} | {r[2]} | {r[3].rstrip(".")} |')
