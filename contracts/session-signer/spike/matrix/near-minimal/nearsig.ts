// One way to sign as a wallet through NEAR, for every matrix harness. Each call is one wallet signature on NEAR
// (MetaMask: an rlp_execute transaction on its stock eth-implicit account; Freighter / Phantom: one readable text
// checked by our stateless signer contract, no NEAR wallet contract), then one MPC signature.
// Every MPC signature is checked locally against the derived key before it is returned.
import { execFileSync } from 'node:child_process';
import nacl from 'tweetnacl';
import { recoverAddress, type Hex, toHex, getAddress, keccak256 } from 'viem';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import bs58 from 'bs58';
import { Keypair } from '@stellar/stellar-sdk';
import { actionCreators } from '@near-js/transactions';

export type Wallet = 'MetaMask' | 'Freighter' | 'Phantom';
const here = process.cwd();
process.chdir('/home/ubuntu/work/near-session-spike'); // mm.ts reads secrets/ relative to here
const mm = await import('/home/ubuntu/work/near-session-spike/mm.ts');
const { deriveEd25519 } = await import('/home/ubuntu/work/near-session-spike/near.ts');
process.chdir(here);
export const metamask = mm.metamask;
export const stats = { calls: 0, ms: 0 };
/** NEAR transaction ids of every MPC request, newest last (proof links). */
export const nearTxs: string[] = [];

// Freighter and Phantom: one readable text per request, checked by our signer contract, which asks the MPC to sign
// under "<wallet key hex>/<path>" (predecessor: the signer contract). No NEAR wallet contract involved.
export const SIGNER = `signer.${JSON.parse(readFileSync('/home/ubuntu/work/near-session-spike/secrets/near.json', 'utf8')).accountId}`;
const FREIGHTER_FILE = '/home/ubuntu/work/near-wallet-spike/secrets/freighter-b.json';
const fr = Keypair.fromSecret(JSON.parse(readFileSync(FREIGHTER_FILE, 'utf8')).secret);
const phSecret = bs58.decode(JSON.parse(readFileSync('/home/ubuntu/work/phantom-spike/secrets/phantom-test.json', 'utf8')).secret);
const ph = nacl.sign.keyPair.fromSecretKey(phSecret.length === 64 ? phSecret : nacl.sign.keyPair.fromSeed(phSecret).secretKey);
const walletKey = (w: 'Freighter' | 'Phantom') => Buffer.from(w === 'Freighter' ? fr.rawPublicKey() : ph.publicKey).toString('hex');
export const requestText = (path: string, domain: 0 | 1, payloadHex: string) => `Prime NEAR signer\ncontract: ${SIGNER}\npath: ${path}\ndomain: ${domain}\npayload: ${payloadHex}`;
function walletSign(w: 'Freighter' | 'Phantom', text: string): string {
  if (w === 'Phantom') return Buffer.from(nacl.sign.detached(Buffer.from(text, 'utf8'), ph.secretKey)).toString('hex'); // Phantom signMessage
  const d = mkdtempSync(`${tmpdir()}/fsign-`); writeFileSync(`${d}/m.txt`, text);          // Freighter signMessage (SEP-53)
  try { return Buffer.from(execFileSync('bun', ['freighter-sign.ts', FREIGHTER_FILE, `${d}/m.txt`], { cwd: '/home/ubuntu/work/near-session-spike', encoding: 'utf8' }), 'base64').toString('hex'); }
  finally { rmSync(d, { recursive: true }); }
}
/** NEAR's load-balanced RPC can serve a lagging node: a fresh transaction is rejected as expired or with a stale nonce.
 *  A rejected transaction never lands, so retry after the node catches up. */
async function retryExpired<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await f(); }
    catch (e: any) { if (i < 5 && /expired|nonce/i.test(String(e?.message ?? e))) { await new Promise((r) => setTimeout(r, 3000)); continue; } throw e; }
  }
}
/** One request to the signer contract; returns the MPC response JSON. */
async function viaSigner(w: 'Freighter' | 'Phantom', path: string, domain: 0 | 1, payload: Uint8Array): Promise<any> {
  const hex = Buffer.from(payload).toString('hex');
  const args = { key: walletKey(w), sep53: w === 'Freighter', path, domain_id: domain, payload: hex, signature: walletSign(w, requestText(path, domain, hex)) };
  const out: any = await retryExpired(() => mm.relayer.signAndSendTransaction({ receiverId: SIGNER, actions: [actionCreators.functionCall('sign', args, 300_000_000_000_000n, 1n)], waitUntil: 'FINAL', throwOnFailure: false }));
  nearTxs.push(out.transaction_outcome?.id);
  const v = out.status?.SuccessValue;
  if (!v) throw new Error(`signer: no MPC result in ${out.transaction_outcome?.id}: ${JSON.stringify(out.status).slice(0, 600)}`);
  return JSON.parse(Buffer.from(v, 'base64').toString());
}
const memo = new Map<string, any>();

/** The wallet's NEAR MPC ed25519 key for `path` (Solana / Stellar). */
export async function edKey(w: Wallet, path: string): Promise<Uint8Array> {
  const k = `ed:${w}:${path}`;
  if (!memo.has(k)) {
    if (w === 'MetaMask') memo.set(k, await deriveEd25519(mm.ethAccountId, path));
    else memo.set(k, await deriveEd25519(SIGNER, `${walletKey(w)}/${path}`));
  }
  return memo.get(k);
}

/** One MPC ed25519 signature over `msg` by the wallet's NEAR account, verified against edKey. */
export async function edSign(w: Wallet, path: string, msg: Uint8Array): Promise<Uint8Array> {
  const t0 = Date.now();
  let sig: Uint8Array;
  if (w === 'MetaMask') { const here2 = process.cwd(); process.chdir('/home/ubuntu/work/near-session-spike'); try { const r = await retryExpired(() => mm.mpcSign(msg, path)); sig = r.sig; nearTxs.push(r.nearTx); } finally { process.chdir(here2); } }
  else { const r = await viaSigner(w, path, 1, msg); sig = Uint8Array.from(r.signature ?? r.Ed25519?.signature); }
  stats.calls++; stats.ms += Date.now() - t0;
  if (!nacl.sign.detached.verify(msg, sig, await edKey(w, path))) throw new Error(`MPC ed25519 signature for ${w} does not verify against its derived key`);
  return sig;
}

/** The wallet's NEAR MPC secp256k1 address for `path` (EVM), learned by recovering one probe signature. */
export async function secpAddr(w: 'Freighter' | 'Phantom', path: string): Promise<Hex> {
  const k = `secp:${w}:${path}`;
  if (!memo.has(k)) { const h = keccak256(toHex(`prime probe ${w} ${path}`)); memo.set(k, getAddress(await recoverAddress({ hash: h, signature: await rawSecp(w, path, h) }))); }
  return memo.get(k);
}
async function rawSecp(w: 'Freighter' | 'Phantom', path: string, prehash: Hex): Promise<Hex> {
  const t0 = Date.now();
  const r = await viaSigner(w, path, 0, Buffer.from(prehash.slice(2), 'hex'));
  stats.calls++; stats.ms += Date.now() - t0;
  const R = r.big_r?.affine_point ?? r.Secp256k1?.big_r?.affine_point, S = r.s?.scalar ?? r.Secp256k1?.s?.scalar, v = r.recovery_id ?? r.Secp256k1?.recovery_id;
  return `0x${R.slice(2)}${S}${(27 + Number(v)).toString(16)}` as Hex;
}
/** One MPC secp256k1 signature over a 32-byte prehash, as r||s||v (v = 27/28), checked by recovering secpAddr. */
export async function secpSign(w: 'Freighter' | 'Phantom', path: string, prehash: Hex): Promise<Hex> {
  const sig = await rawSecp(w, path, prehash);
  if (getAddress(await recoverAddress({ hash: prehash, signature: sig })) !== await secpAddr(w, path)) throw new Error(`MPC secp256k1 signature for ${w} does not recover to its address`);
  return sig;
}
export { toHex };
