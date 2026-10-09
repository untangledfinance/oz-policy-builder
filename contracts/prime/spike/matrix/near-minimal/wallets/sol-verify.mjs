// Verifies a Solana wallet's outputs the way prime-session and prime-near-signer do: ed25519 over the raw UTF-8 bytes of the text (no prefix),
// and for transactions ed25519 over the serialized message (the validator's check), plus whether the wallet changed the message.
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Transaction, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { readFileSync, writeFileSync } from 'node:fs';
const H = '/home/ubuntu/work/wallet-matrix/real';
const name = process.argv[2];
const P = JSON.parse(readFileSync(`${H}/payloads/solana.json`, 'utf8'));
const S = JSON.parse(readFileSync(`${H}/out/${name}.solana.json`, 'utf8'));
const res = {}; const rec = (k, ok, why = '') => { res[k] = (ok ? 'PASS' : 'FAIL') + (why ? ` ${why}` : ''); console.log(name, k, res[k]); };
const pk = new PublicKey(S.address).toBytes();
rec('address', S.address === P.owner || S.address === P.ownerAlt, S.address === P.owner ? 'm/44\'/501\'/0\'/0\'' : S.address);
const t = (s) => new TextEncoder().encode(s);
for (const [k, text, label] of [['near', P.nearText, 'prime-near-signer text'], ['grant', P.grantText, 'prime-session grant text']]) {
  if (!S[k]) continue; const sig = Buffer.from(S[k], 'base64');
  if (sig.length !== 64) { rec(`${label}: ed25519 over raw UTF-8`, false, `${sig.length} bytes`); continue; }
  const raw = nacl.sign.detached.verify(t(text), sig, pk);
  const prefixed = nacl.sign.detached.verify(Buffer.concat([Buffer.from('\xffsolana offchain'), t(text)]), sig, pk);
  rec(`${label}: ed25519 over raw UTF-8`, raw, raw ? '' : prefixed ? 'signed with an offchain-message prefix' : 'no format matched');
}
for (const [k, versioned, msgField, label] of [['legacy', false, 'legacyMsg', 'legacy transfer'], ['v0', true, 'v0Msg', 'v0 transfer'], ['relayer', false, 'relayerMsg', 'relayer-paid memo (wallet is signer only)']]) {
  if (!S[k]) continue;
  try {
    const raw = Buffer.from(S[k], 'base64'); const tx = versioned ? VersionedTransaction.deserialize(raw) : Transaction.from(raw);
    const msg = versioned ? Buffer.from(tx.message.serialize()) : tx.serializeMessage();
    const sig = versioned ? tx.signatures[0] : tx.signatures.find((s) => s.publicKey.equals(new PublicKey(S.address)))?.signature;
    const ok = !!sig && nacl.sign.detached.verify(msg, sig, pk);
    rec(`signTransaction ${label}: ed25519 over message`, ok, `message ${msg.toString('base64') === P[msgField] ? 'unchanged' : 'REWRITTEN by wallet'}`);
  } catch (e) { rec(`signTransaction ${label}: ed25519 over message`, false, String(e.message).slice(0, 80)); }
}
writeFileSync(`${H}/out/${name}.solana.verify.json`, JSON.stringify(res, null, 1));
