# Counts passing checks per requirement group from a psw.ts state file. Usage: python3 psw-summary.py <label>   (label = devnet-build | mainnet-build | mainnet-build-near)
import json, re, sys
label = sys.argv[1]
d = json.load(open(f'/home/ubuntu/work/prime-refine/logs/swig/state-psw-{label}.json'))
rs = [r for r in d['results'] if not r['name'].startswith('FINDING')]
groups = [
  ('Swig signs the Squads policy move (policy signer)', r'^(P3\.|G-.*[234]\.|G9[cdf]\.|G10[ab]\.|M2-m|M\d\.|T[256]\.|T6\.|D0\.|D3\.)'),
  ('Seats stay plain keys; no Swig wallet is a seat; session never votes or edits settings', r'^(P1\.|N[0-5]|N4b)'),
  ('Session admin: the session key cannot manage, restart or widen its role', r'^(N6|N6b|N7|N5b)'),
  ('One owner signature starts a session, every wallet type', r'^(G-.*1\.|G9[ab]\.)'),
  ('Rule-allowed moves only (policy refusals)', r'^(G-.*[56]\.|G9e\.|T[34]\.)'),
  ('Fees: relayer pays, session key pays its own, empty key fails', r'^G-.*[237][ab]?\.'),
  ('Expiry and maximum length', r'^E\d'),
  ('Revoke by the owner alone, per wallet type', r'^R-'),
  ('Cross-wallet, cross-account and replay', r'^X'),
  ('The 2-of-3 removes a wallet from the policy', r'^D\d'),
  ('Config hazards and the frozen variant', r'^(H\d|N9)'),
  ('SPL token flows through Swig and Squads', r'^T'),
  ('Withheld-grant race', r'^R2'),
]
tot = len(rs); ok = sum(r['pass'] for r in rs)
print(f'{label}: {ok}/{tot} checks (plus {len(d["results"]) - tot} findings)')
for name, rx in groups:
    g = [r for r in rs if re.search(rx, r['name'])]
    print(f'| {name} | {sum(r["pass"] for r in g)}/{len(g)} |')
