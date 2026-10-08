#!/usr/bin/env python3
"""Counts of pss.ts results per requirement, and the metrics. Usage: summary.py <state.json>"""
import json, re, statistics, sys

d = json.load(open(sys.argv[1]))
res, m = d['results'], d['metrics']


def key(name):
    return name.split('.')[0].split(' ')[0]


ROWS = [
    ('owner + owner decide (vault, settings, policy)', r'^(K2|K3|K4|K5|K7|K8|R4|R5)$'),
    ('Squads permissions, seat checks and old seat keys', r'^(Q\d+b?c?|K1-.*|K6c|K6d2?|K6e|K6f-.*|K6g|K6h|K6i|P0b?)$'),
    ('vote session + another owner; session approvals', r'^(D1b?c?|D2c?d?f?|D3b?c?d?e?|S1|S1b|S1e|S1f|M6|M8|M9)$'),
    ('move-only session refused as a vote', r'^(N\d+b?)$'),
    ('owner + its own session counts once', r'^(D5b|D5c|D5d|D5e|D5f|D5g)$'),
    ('session alone refused', r'^(D6.*|D7|D8)$'),
    ('expired or revoked refused (votes)', r'^(D9|D9b|D9c|D10|D10b|D11.*|D14b?)$'),
    ("A's session for B's PDA, wallet or key refused", r'^(D12.*|D13|X1|X2|X3|X4|X4b|X5|X6|X7.|X8)$'),
    ('cross-account replay refused', r'^(A3v?|A4v?|A5b|A5w|A6v?|X9a|V6.)$'),
    ('moves from psn.ts: sessions, caps, expiry (G)', r'^(G-.*|G9|G1[0-3]b?)$'),
    ('moves from psn.ts: second program id, bump, markers, revoke (V, X7, X10, X11)', r'^(V.*|X10|X11.|X7.)$'),
    ('moves from psn.ts: account B, policy install, removal (A, R)', r'^(A0|A1|A2|A5|A5-M\d|A5-R\d|R0|R1|R2|R3|R6|R7|R8)$'),
    ('the dangerous case (S)', r'^(S\d.*)$'),
    ('on-chain code equals the .so', r'^(ZA|ZB)$'),
]
seen = set()
print(f"{'requirement':80} pass/total  ids")
tot = 0
for label, rx in ROWS:
    rs = [r for r in res if re.match(rx, key(r['name']))]
    ids = sorted({key(r['name']) for r in rs})
    seen.update(id(r) for r in rs)
    print(f"{label:80} {sum(r['pass'] for r in rs)}/{len(rs)}  {','.join(ids)[:90]}")
rest = [r for r in res if id(r) not in seen]
print('not in a row:', [key(r['name']) for r in rest])
print('total', sum(r['pass'] for r in res), '/', len(res))
print()
for k, v in m.items():
    if re.match(r'(move8?|vote-owner|vote-session)-sample', k):
        continue
    print(k, json.dumps(v))
s = [m[f'move-sample-{i}'] for i in range(10)]
print('seat move: median total', statistics.median([x['totalCu'] for x in s]), 'own', statistics.median([x['programOwnCu'] for x in s]), 'bytes', s[0]['bytes'])
if 'move8-sample-0' in m:
    p = [m[f'move8-sample-{i}'] for i in range(10)]
    print('production move: median total', statistics.median([x['totalCu'] for x in p]), 'own', statistics.median([x['programOwnCu'] for x in p]), 'bytes', p[0]['bytes'])
print('mpc', d.get('mpc'))
print('sha', d.get('soSha256'), d.get('onchainShaA'), d.get('onchainShaB'), d.get('soBytes'))
