// Verifies a Stellar wallet's outputs: SEP-53 over the prime-near-signer text (what prime-near-signer checks with sep53 = true),
// Soroban auth-entry signatures (host check: ed25519 over sha256(HashIdPreimage)), and signed transactions (ed25519 over the tx hash).
import * as Sdk from '@stellar/stellar-sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const H = '/home/ubuntu/work/wallet-matrix/real';
const name = process.argv[2];
const P = JSON.parse(readFileSync(`${H}/payloads/stellar.json`, 'utf8'));
const S = JSON.parse(readFileSync(`${H}/out/${name}.stellar.json`, 'utf8'));
const kp = Sdk.Keypair.fromPublicKey(S.address ?? P.address);
const res = {}; const rec = (k, ok, why = '') => { res[k] = (ok ? 'PASS' : 'FAIL') + (why ? ` ${why}` : ''); console.log(name, k, res[k]); };
const v = (o, k) => { const x = typeof o[k] === 'function' ? o[k]() : o[k]; return x && x.value ? Buffer.from(x.value) : Buffer.from(x); };
const sha = (b) => createHash('sha256').update(b).digest();
const toBuf = (v) => { if (v == null) return null; if (typeof v === 'object' && v.type === 'Buffer') return Buffer.from(v.data); if (Array.isArray(v)) return Buffer.from(v); if (typeof v === 'string') { if (/^[0-9a-fA-F]{128}$/.test(v)) return Buffer.from(v, 'hex'); return Buffer.from(v, 'base64'); } return Buffer.from(v); };
if (S.address) rec('address', S.address === P.address, S.address);
const verifyAny = (label, sig, candidates) => { const b = toBuf(sig); if (!b || b.length !== 64) return rec(label, false, `signature is ${b?.length} bytes`); const hit = Object.entries(candidates).find(([, m]) => kp.verify(m, b)); rec(label, !!hit && hit[0] === 'expected', hit ? hit[0] : 'no format matched'); };
const text = P.nearText;
if (S.near) verifyAny('near text: SEP-53 sha256("Stellar Signed Message:\\n"+text)', S.near, { expected: sha(Buffer.concat([Buffer.from('Stellar Signed Message:\n'), Buffer.from(text)])), rawText: Buffer.from(text), sha256Text: sha(Buffer.from(text)) });
for (const [k, pre, label] of [['grant', P.grantPreimage, 'grant auth entry'], ['vote', P.votePreimage, 'seat-vote auth entry']]) {
  if (!S[k]) continue; const raw = Buffer.from(pre, 'base64');
  verifyAny(`${label}: ed25519 over sha256(preimage)`, S[k], { expected: sha(raw), rawPreimage: raw });
}
if (S.tx) { try { const tx = Sdk.TransactionBuilder.fromXDR(S.tx, P.passphrase); const sigs = tx.signatures; const ok = sigs.length === 1 && kp.verify(tx.hash(), v(sigs[0], 'signature')) && Buffer.compare(v(sigs[0], 'hint'), kp.signatureHint()) === 0; rec('signTransaction: ed25519 over tx hash', ok, `${sigs.length} sig(s), same payload: ${tx.hash().toString('hex') === P.txHash}`); } catch (e) { rec('signTransaction: ed25519 over tx hash', false, String(e.message).slice(0, 80)); } }
writeFileSync(`${H}/out/${name}.stellar.verify.json`, JSON.stringify(res, null, 1));
