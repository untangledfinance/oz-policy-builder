import json, re, sys
sys.argv = [sys.argv[0], sys.argv[1]]
d = json.load(open(sys.argv[1])); res = d['results']
def key(n): return n.split('.')[0].split(' ')[0]
ROWS = [
 ('Owner + owner decide a vault transfer, a settings change and a policy install', r'^(K2|K3|K4|K5|K7|K8|R4|R5|R9b?)$', 'K2 to K5, K7, K8, R4, R5, R9'),
 ('Squads treats the PDA as a seat: permissions, old seat keys, outsiders', r'^(Q\d+b?c?|K1-.*|K6c|K6d2?|K6e|K6f-.*|K6g|K6h|K6i|P0b?|T4b?)$', 'P0, K1, K6, Q0 to Q11, T4'),
 ('Vote session + another owner; two vote sessions; session approvals', r'^(D1b?c?|D2c?d?f?|D3b?c?d?e?|S1|S1b|S1e|S1f|M6|M8|M9|M13-\da)$', 'D1 to D3, S1, M6 to M9, M13'),
 ('Move-only session refused as a vote', r'^(N\d+b?)$', 'N0 to N9'),
 ('Owner + its own session counts once', r'^(D5b|D5c|D5d|D5e|D5f|D5g)$', 'D5'),
 ('Session alone refused', r'^(D6.*|D7|D8)$', 'D6 to D8'),
 ('Expired, stretched, revoked and flag-tampered grants refused as votes', r'^(D9|D9b|D9c|D10|D10b|D11.*|D14b?)$', 'D9 to D11, D14'),
 ("A's session for B's PDA, wallet, path or program refused", r'^(D12.*|D13|X1|X2|X3|X4|X4b|X5|X6|X7.|X8)$', 'D12, D13, X1 to X8'),
 ('Cross-account replay refused', r'^(A3v?|A4v?|A5b|A5w|A6v?|X9a|V6.)$', 'A3 to A6, X9a, V6'),
 ('Moves from psn.ts: relayed and self-paid, policy limits, expiry, replay', r'^(G-.*|G9|G1[0-3]b?)$', 'G'),
 ('Moves from psn.ts: second program id, bump, markers, revoke', r'^(V.*|X10|X11.|X7.)$', 'V, X7, X10, X11'),
 ('Moves from psn.ts: second account, policy install, removal from the policy', r'^(A0|A1|A2|A5|A5-M\d|A5-R\d|R0|R1|R2|R3|R6|R7|R8)$', 'A, R'),
 ('The dangerous case', r'^(S\d.*)$', 'S0 to S4'),
 ('Threshold 1: what the move-only gate stops', r'^(T[0-3]b?)$', 'T0 to T3'),
 ('On-chain code of both program ids equals the .so', r'^(ZA|ZB)$', 'ZA, ZB'),
]
print('| Requirement | Result | Checks |\n|---|---|---|')
for label, rx, ids in ROWS:
    rs = [r for r in res if re.match(rx, key(r['name']))]
    print(f"| {label} | {sum(r['pass'] for r in rs)}/{len(rs)} | {ids} |")
print(f"\nTotal {sum(r['pass'] for r in res)}/{len(res)}")
