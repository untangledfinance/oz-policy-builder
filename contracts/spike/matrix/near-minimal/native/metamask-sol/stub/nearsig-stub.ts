// Dry-run replacement for near-session-spike/nearsig.ts: the NEAR wallets' MPC keys become local keys derived from (wallet, path).
// Same exports and the same signing formats, no NEAR calls. Used only to test harness code without the NEAR lock; real runs use nearsig.ts.
import nacl from 'tweetnacl';
import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { getAddress, keccak256, toHex, type Hex } from 'viem';
export type Wallet = 'MetaMask' | 'Freighter' | 'Phantom';
export const stats = { calls: 0, ms: 0 };
export const nearTxs: string[] = [];
const seed = (tag: string) => createHash('sha256').update(`prime-stub:${tag}`).digest();
export const metamask = privateKeyToAccount(`0x${seed('metamask-evm').toString('hex')}`);
const ed = (w: Wallet, path: string) => nacl.sign.keyPair.fromSeed(seed(`ed:${w}:${path}`));
const secp = (w: string, path: string) => privateKeyToAccount(`0x${seed(`secp:${w}:${path}`).toString('hex')}`);
export async function edKey(w: Wallet, path: string) { return ed(w, path).publicKey; }
export async function edSign(w: Wallet, path: string, msg: Uint8Array) { stats.calls++; return nacl.sign.detached(msg, ed(w, path).secretKey); }
export async function secpAddr(w: 'Freighter' | 'Phantom', path: string): Promise<Hex> { return getAddress(secp(w, path).address); }
export async function secpSign(w: 'Freighter' | 'Phantom', path: string, prehash: Hex): Promise<Hex> { stats.calls++; return secp(w, path).sign({ hash: prehash }); }
export { toHex };
