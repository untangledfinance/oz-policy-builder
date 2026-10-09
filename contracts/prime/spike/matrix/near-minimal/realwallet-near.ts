// Real-extension proof for prime-near-signer.
//   bun realwallet-near.ts prepare <out.json> <path> <domain> <payloadHex>   -> writes { text, path, domain, payload }
//   bun realwallet-near.ts submit <in.json> <result.json> <sep53 0|1>       -> submits the wallet's signature to the
//      signer contract, prints the NEAR tx and checks the MPC signature against the key derived for that wallet.
import { readFileSync, writeFileSync } from 'node:fs';
import nacl from 'tweetnacl';
import { recoverAddress, type Hex } from 'viem';
import { actionCreators } from '@near-js/transactions';
const { SIGNER, requestText } = await import('./nearsig.ts');
const mm = await import('./mm.ts');
const { deriveEd25519 } = await import('./near.ts');
const [mode, a, b, c, d] = process.argv.slice(2);
if (mode === 'prepare') {
  writeFileSync(a!, JSON.stringify({ text: requestText(b!, Number(c) as 0 | 1, d!), path: b, domain: Number(c), payload: d }));
  process.exit(0);
}
const req = JSON.parse(readFileSync(a!, 'utf8'));
const res = JSON.parse(readFileSync(b!, 'utf8')).result;
const key = Buffer.from(res.key).toString('hex'), sig = Buffer.from(res.sig).toString('hex');
const sep53 = c === '1';
console.log('wallet key', key, 'signed text locally valid:', sep53 ? '(SEP-53, checked by contract)' : nacl.sign.detached.verify(new TextEncoder().encode(req.text), Buffer.from(sig, 'hex'), Buffer.from(key, 'hex')));
const args = { key, sep53, path: req.path, domain_id: req.domain, payload: req.payload, signature: sig };
const out: any = await mm.relayer.signAndSendTransaction({ receiverId: SIGNER, actions: [actionCreators.functionCall('sign', args, 300_000_000_000_000n, 1n)], waitUntil: 'FINAL', throwOnFailure: false });
console.log('NEAR tx', out.transaction_outcome?.id, 'status', Object.keys(out.status ?? {}));
const v = out.status?.SuccessValue; if (!v) { console.log(JSON.stringify(out.status).slice(0, 500)); process.exit(1); }
const r = JSON.parse(Buffer.from(v, 'base64').toString());
const msg = Buffer.from(req.payload, 'hex');
if (req.domain === 1) {
  const derived = await deriveEd25519(SIGNER, `${key}/${req.path}`);
  console.log('MPC ed25519 signature verifies against the key derived for this wallet:', nacl.sign.detached.verify(msg, Uint8Array.from(r.signature ?? r.Ed25519?.signature), derived));
} else {
  const R = r.big_r?.affine_point ?? r.Secp256k1?.big_r?.affine_point, S = r.s?.scalar ?? r.Secp256k1?.s?.scalar, rv = r.recovery_id ?? r.Secp256k1?.recovery_id;
  console.log('MPC secp256k1 signature recovers to', await recoverAddress({ hash: `0x${req.payload}` as Hex, signature: `0x${R.slice(2)}${S}${(27 + Number(rv)).toString(16)}` as Hex }));
}
process.exit(0);
