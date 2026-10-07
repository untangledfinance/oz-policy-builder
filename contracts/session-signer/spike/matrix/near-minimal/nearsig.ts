// One way to sign as a wallet through NEAR, for every matrix harness. Each call is one wallet signature on NEAR
// (MetaMask: an rlp_execute transaction on its eth-implicit account; Freighter: SEP-53 text on our SEP-53 wallet
// contract account; Phantom: plain text on our text-ed25519 wallet contract account), then one MPC signature.
// Every MPC signature is checked locally against the derived key before it is returned.
import { execFileSync } from 'node:child_process';
import nacl from 'tweetnacl';
import { recoverAddress, type Hex, toHex, getAddress } from 'viem';

export type Wallet = 'MetaMask' | 'Freighter' | 'Phantom';
const here = process.cwd();
process.chdir('/home/ubuntu/work/near-session-spike'); // mm.ts reads secrets/ relative to here
const mm = await import('/home/ubuntu/work/near-session-spike/mm.ts');
const { deriveEd25519 } = await import('/home/ubuntu/work/near-session-spike/near.ts');
process.chdir(here);
export const metamask = mm.metamask;
export const stats = { calls: 0, ms: 0 };

function matrixSign(w: 'freighter' | 'phantom', domain: 0 | 1, path: string, hex?: string) {
  return execFileSync('/home/ubuntu/work/evm-matrix/near-sign.sh', [w, String(domain), path, ...(hex ? [hex] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
}
const memo = new Map<string, any>();

/** The wallet's NEAR MPC ed25519 key for `path` (Solana / Stellar). */
export async function edKey(w: Wallet, path: string): Promise<Uint8Array> {
  const k = `ed:${w}:${path}`;
  if (!memo.has(k)) {
    if (w === 'MetaMask') memo.set(k, await deriveEd25519(mm.ethAccountId, path));
    else memo.set(k, Uint8Array.from(Buffer.from(matrixSign(w.toLowerCase() as any, 1, path).match(/PK ([0-9a-f]{64})/)![1]!, 'hex')));
  }
  return memo.get(k);
}

/** One MPC ed25519 signature over `msg` by the wallet's NEAR account, verified against edKey. */
export async function edSign(w: Wallet, path: string, msg: Uint8Array): Promise<Uint8Array> {
  const t0 = Date.now();
  let sig: Uint8Array;
  if (w === 'MetaMask') { const here2 = process.cwd(); process.chdir('/home/ubuntu/work/near-session-spike'); try { sig = (await mm.mpcSign(msg, path)).sig; } finally { process.chdir(here2); } }
  else sig = Uint8Array.from(Buffer.from(matrixSign(w.toLowerCase() as any, 1, path, Buffer.from(msg).toString('hex')).match(/SIG ([0-9a-f]{128})/)![1]!, 'hex'));
  stats.calls++; stats.ms += Date.now() - t0;
  if (!nacl.sign.detached.verify(msg, sig, await edKey(w, path))) throw new Error(`MPC ed25519 signature for ${w} does not verify against its derived key`);
  return sig;
}

/** The wallet's NEAR MPC secp256k1 address for `path` (EVM). MetaMask is native on EVM and never needs this. */
export async function secpAddr(w: 'Freighter' | 'Phantom', path: string): Promise<Hex> {
  const k = `secp:${w}:${path}`;
  if (!memo.has(k)) memo.set(k, getAddress(matrixSign(w.toLowerCase() as any, 0, path).match(/ADDR (0x[0-9a-f]{40})/)![1]!));
  return memo.get(k);
}

/** One MPC secp256k1 signature over a 32-byte prehash, as r||s||v (v = 27/28), checked by recovering secpAddr. */
export async function secpSign(w: 'Freighter' | 'Phantom', path: string, prehash: Hex): Promise<Hex> {
  const t0 = Date.now();
  const out = matrixSign(w.toLowerCase() as any, 0, path, prehash.slice(2));
  stats.calls++; stats.ms += Date.now() - t0;
  const sig = `0x${out.match(/SIG ([0-9a-f]{128})/)![1]}${(27 + Number(out.match(/V (\d)/)![1])).toString(16)}` as Hex;
  if (getAddress(await recoverAddress({ hash: prehash, signature: sig })) !== await secpAddr(w, path)) throw new Error(`MPC secp256k1 signature for ${w} does not recover to its address`);
  return sig;
}
export { toHex };
