// Test dApp for "can real Phantom sign a NEAR transaction?" (NEAR testnet only).
// Phantom's key is ed25519; its NEAR implicit account id is hex(pubkey). The page asks Phantom to
// signMessage(sha256(borsh(tx))) — exactly what a NEAR transaction signature covers — and we submit it.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { base58 } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519.js';
import { actionCreators, createTransaction, encodeTransaction, SignedTransaction, Signature } from '@near-js/transactions';
import { PublicKey, KeyType } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { relayer } from './mm.ts';
import { execFileSync } from 'node:child_process';
// Phantom 26.32.0 background/isValidUTF8, copied verbatim (chunk-GN2XWC4M.js o_t).
function phantomIsValidUTF8(e:Uint8Array){let t=e.length,r=0;for(;r<t;)if(!(e[r]&128))r++;else if((e[r]&224)===192){if(r+1===t||(e[r+1]&192)!==128||(e[r]&254)===192)return!1;r+=2}else if((e[r]&240)===224){if(r+2>=t||(e[r+1]&192)!==128||(e[r+2]&192)!==128||e[r]===224&&(e[r+1]&224)===128||e[r]===237&&(e[r+1]&224)===160)return!1;r+=3}else if((e[r]&248)===240){if(r+3>=t||(e[r+1]&192)!==128||(e[r+2]&192)!==128||(e[r+3]&192)!==128||e[r]===240&&(e[r+1]&240)===128||e[r]===244&&e[r+1]>143||e[r]>244)return!1;r+=4}else return!1;return!0}
import { MPC, NEAR_RPC, rpc, deriveEd25519, view } from './near.ts';

const PATH = 'prime:phantom-spike/stellar-1';
const provider = new JsonRpcProvider({ url: NEAR_RPC });
const pending = new Map<string, any>();
const log = (...a: unknown[]) => { console.log(new Date().toISOString().slice(11, 19), ...a); };

async function prepare(solPk: string, payloadHex: string) {
  const pk = base58.decode(solPk);
  const implicit = Buffer.from(pk).toString('hex');
  try { await rpc('query', { request_type: 'view_account', finality: 'final', account_id: implicit }); }
  catch { log('funding implicit account', implicit); await relayer.signAndSendTransaction({ receiverId: implicit, actions: [actionCreators.transfer(10n ** 23n)], waitUntil: 'FINAL' }); }
  const nearPk = new PublicKey({ keyType: KeyType.ED25519, data: pk });
  const ak = await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: implicit, public_key: nearPk.toString() });
  const block = await rpc('block', { finality: 'final' });
  const args = { request: { path: PATH, payload_v2: { Eddsa: payloadHex }, domain_id: 1 } };
  const build = (gas: bigint) => createTransaction(implicit, nearPk, MPC, BigInt(ak.nonce) + 1n,
    [actionCreators.functionCall('sign', args, gas, 1n)], base58.decode(block.header.hash));
  // Grind the gas field so sha256(tx) is valid UTF-8 (Phantom only signs UTF-8 messages).
  const MARK = 30_000_000_000_017n;
  const probe = Buffer.from(encodeTransaction(build(MARK)));
  const le = Buffer.alloc(8); le.writeBigUInt64LE(MARK);
  const off = probe.indexOf(le); if (off < 0 || probe.indexOf(le, off + 1) >= 0) throw new Error('gas offset not unique');
  const [g, , tries, secs] = execFileSync('/home/ubuntu/work/phantom-spike/grind/target/release/grind',
    [probe.toString('hex'), String(off), '30000000000000', '300000000000000'], { encoding: 'utf8' }).trim().split(' ');
  log('ground gas', { gas: g, tries, secs });
  const tx = build(BigInt(g));
  const bytes = encodeTransaction(tx);
  const hash = createHash('sha256').update(bytes).digest();
  if (!phantomIsValidUTF8(hash)) throw new Error('hash is not valid UTF-8 per Phantom rules');
  const id = Math.random().toString(36).slice(2);
  pending.set(id, { tx, hash, implicit, pk, payloadHex });
  log('prepared', { implicit, txBytes: bytes.length, hash: hash.toString('hex') });
  return { id, implicit, hashHex: hash.toString('hex'), txBytesB64: Buffer.from(bytes).toString('base64') };
}

async function submit(id: string, sigB58: string) {
  const p = pending.get(id); if (!p) throw new Error('unknown id');
  const sig = base58.decode(sigB58);
  const local = ed25519.verify(sig, p.hash, p.pk);
  log('phantom signature verifies over sha256(borsh(tx)) locally:', local);
  const signed = new SignedTransaction({ transaction: p.tx, signature: new Signature({ keyType: KeyType.ED25519, data: sig }) });
  const t0 = Date.now();
  const out: any = await provider.sendTransactionUntil(signed, 'FINAL').catch((e: any) => ({ error: String(e?.message ?? e).slice(0, 400) }));
  if (out.error) return { local, accepted: false, error: out.error };
  const nearTx = out.transaction_outcome?.id;
  let mpcSig: Uint8Array | undefined;
  for (const r of out.receipts_outcome ?? []) {
    const v = r.outcome?.status?.SuccessValue; if (!v) continue;
    try { const j = JSON.parse(Buffer.from(v, 'base64').toString()); const s = j?.signature ?? j?.Ed25519?.signature; if (Array.isArray(s) && s.length === 64) mpcSig = Uint8Array.from(s); } catch {}
  }
  const derived = await deriveEd25519(p.implicit, PATH);
  const onchain: string = await view(MPC, 'derived_public_key', { path: PATH, predecessor: p.implicit, domain_id: 1 });
  const res = {
    local, accepted: true, nearTx, ms: Date.now() - t0,
    mpcSignature: !!mpcSig,
    mpcVerifies: mpcSig ? ed25519.verify(mpcSig, Buffer.from(p.payloadHex, 'hex'), derived) : false,
    derivedMatchesContract: onchain === 'ed25519:' + base58.encode(derived),
    derivedKey: 'ed25519:' + base58.encode(derived),
  };
  log('result', res);
  writeFileSync('/home/ubuntu/work/phantom-spike/result.json', JSON.stringify(res, null, 1));
  return res;
}

const PAGE = `<!doctype html><meta charset=utf-8><title>Prime NEAR test</title>
<body style="font-family:sans-serif"><h3>Phantom → NEAR testnet</h3><pre id=out></pre>
<script>
const out = (m) => document.getElementById('out').textContent += m + '\\n';
window.runTest = async (payloadHex) => {
  const sol = window.phantom?.solana; if (!sol?.isPhantom) throw new Error('Phantom not injected');
  const { publicKey } = await sol.connect(); const pk = publicKey.toString(); out('connected ' + pk);
  const prep = await (await fetch('/prepare', { method: 'POST', body: JSON.stringify({ pk, payloadHex }) })).json();
  out('NEAR account ' + prep.implicit + '\\nsigning sha256(tx) ' + prep.hashHex);
  const msg = Uint8Array.from(prep.hashHex.match(/../g).map(h => parseInt(h, 16)));
  const { signature } = await sol.signMessage(msg, 'utf8');
  const A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n=0n; for (const b of signature) n = n*256n + BigInt(b);
  let s=''; while (n>0n) { s = A[Number(n%58n)] + s; n /= 58n; } for (const b of signature) { if (b) break; s = '1' + s; }
  out('phantom signed (' + signature.length + ' bytes)');
  const res = await (await fetch('/submit', { method: 'POST', body: JSON.stringify({ id: prep.id, sig: s }) })).json();
  out(JSON.stringify(res, null, 1)); return res;
};
</script>`;

Bun.serve({ port: 8790, hostname: '127.0.0.1', idleTimeout: 120, async fetch(req) {
  const u = new URL(req.url);
  try {
    if (u.pathname === '/') return new Response(PAGE, { headers: { 'content-type': 'text/html' } });
    const b: any = await req.json();
    if (u.pathname === '/prepare') return Response.json(await prepare(b.pk, b.payloadHex));
    if (u.pathname === '/submit') return Response.json(await submit(b.id, b.sig));
  } catch (e: any) { log('ERR', e?.message); return Response.json({ error: String(e?.message ?? e) }, { status: 500 }); }
  return new Response('nf', { status: 404 });
} });
log('listening http://127.0.0.1:8790');
