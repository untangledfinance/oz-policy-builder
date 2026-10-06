import { KeyPair } from '@near-js/crypto';
import { writeFileSync } from 'node:fs';
const kp = KeyPair.fromRandom('ed25519');
const id = `prime-spike-${Date.now().toString(36)}.testnet`;
const r = await fetch('https://helper.nearprotocol.com/account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }) });
console.log(r.status, (await r.text()).slice(0, 300));
if (r.ok) writeFileSync('secrets/near.json', JSON.stringify({ accountId: id, secret: kp.toString() }), { mode: 0o600 });
console.log('account', id);
