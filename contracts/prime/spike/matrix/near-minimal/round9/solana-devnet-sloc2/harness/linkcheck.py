#!/usr/bin/env python3
"""Link check: relative links resolve to files; devnet explorer links resolve on chain (tx succeeded, address exists). Paced for the public RPC."""
import re, sys, os, json, time, urllib.request
RPC = 'https://api.devnet.solana.com'
def rpc(method, params):
    for a in range(8):
        try:
            req = urllib.request.Request(RPC, json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode(), {'content-type': 'application/json'})
            return json.load(urllib.request.urlopen(req, timeout=30))
        except Exception as e:
            time.sleep(1.5 * (a + 1))
    raise SystemExit('rpc failed')
ok = bad = 0; seen = set()
for f in sys.argv[1:]:
    text = open(f).read()
    for m in re.finditer(r'\]\(([^)\s]+)\)', text):
        u = m.group(1)
        if u.startswith('http'):
            mt = re.match(r'https://explorer\.solana\.com/(tx|address)/([1-9A-HJ-NP-Za-km-z]+)\?cluster=devnet$', u)
            if u.startswith('https://explorer.solana.com') and not mt: print('BAD explorer link shape', f, u); bad += 1; continue
            if not mt or u in seen: continue
            seen.add(u); kind, ident = mt.groups(); time.sleep(0.3)
            if kind == 'tx':
                r = rpc('getTransaction', [ident, {'commitment': 'confirmed', 'maxSupportedTransactionVersion': 0}])['result']
                good = r is not None and r['meta']['err'] is None
            else:
                good = rpc('getAccountInfo', [ident, {'encoding': 'base64'}])['result']['value'] is not None
            if good: ok += 1
            else: print('BAD on chain', f, u); bad += 1
        elif u.startswith('#') or u.startswith('mailto:'): continue
        else:
            p = os.path.normpath(os.path.join(os.path.dirname(f), u.split('#')[0]))
            if os.path.exists(p): ok += 1
            else: print('BAD relative', f, u); bad += 1
print(f'links ok {ok}, bad {bad}'); sys.exit(1 if bad else 0)
