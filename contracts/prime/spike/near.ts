// NEAR testnet helpers: view calls, MPC key derivation (offline, cross-checked).
import { sha3_256 } from '@noble/hashes/sha3.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
export const NEAR_RPC = 'https://rpc.testnet.near.org';
export const MPC = 'v1.signer-prod.testnet';
export async function rpc(method: string, params: unknown) {
  const r = await fetch(NEAR_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const b = (await r.json()) as { result?: any; error?: any };
  if (b.error) throw new Error(JSON.stringify(b.error).slice(0, 400));
  return b.result;
}
export async function view(account_id: string, method_name: string, args: unknown) {
  const res = await rpc('query', { request_type: 'call_function', finality: 'final', account_id, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  return JSON.parse(Buffer.from(res.result).toString());
}
/** Same math as octopos packages/prime-core/src/derive.ts, against the TESTNET root key. */
export async function deriveEd25519(predecessor: string, path: string): Promise<Uint8Array> {
  const root: string = await view(MPC, 'public_key', { domain_id: 1 });
  const eps = sha3_256(new TextEncoder().encode(`near-mpc-recovery v0.1.0 epsilon derivation:${predecessor},${path}`));
  let s = 0n; for (let i = eps.length - 1; i >= 0; i--) s = (s << 8n) | BigInt(eps[i]!);
  s %= ed25519.Point.Fn.ORDER;
  const P = ed25519.Point;
  return P.fromBytes(base58.decode(root.split(':')[1]!)).add(P.BASE.multiply(s)).toBytes();
}
