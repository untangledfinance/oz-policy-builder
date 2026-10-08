#!/usr/bin/env python3
"""compare.py <suffix-list...>: median compute units, gate's own units and transaction bytes per move from state-det-<suffix>.json files (deterministic runs: the same keys, seeds and addresses in every build)."""
import json, sys
names = sys.argv[1:]
st = {n: json.load(open(f'state-det-{n}.json')) for n in names}
med = lambda xs: sorted(xs)[len(xs) // 2]
labels = [k for k, v in st[names[0]]['costs'].items() if v.get('samples')]
print(f'{"move":62s}' + ''.join(f'{n:>26s}' for n in names))
for k in labels:
    row = []
    for n in names:
        v = st[n]['costs'].get(k)
        if v and v.get('samples'):
            s = v['samples']; row.append(f"{med([x['cu'] for x in s])}/{med([x.get('gateCu') or 0 for x in s])}/{med([x['bytes'] for x in s])} (n={len(s)})")
        else: row.append('-')
    print(f'{k[:62]:62s}' + ''.join(f'{r:>26s}' for r in row))
for n in names:
    r = st[n]['results']; print(n, sum(x['pass'] for x in r), '/', len(r))
