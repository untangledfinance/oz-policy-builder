// Dry-run stand-in for nearsig.ts: same exports, local keys, no NEAR. Used with NEARSIG_STUB=./nearsig-stub.ts while the harness is developed.
import { keccak256, toHex, getAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
export const stats = { calls: 0, ms: 0 };
export const metamask = privateKeyToAccount(keccak256(toHex('seat-spike stub MetaMask')));
const key = (w: string, path: string) => privateKeyToAccount(keccak256(toHex(`seat-spike stub ${w} ${path}`)));
export const secpAddr = async (w: 'Freighter' | 'Phantom', path: string) => getAddress(key(w, path).address);
export const secpSign = async (w: 'Freighter' | 'Phantom', path: string, prehash: Hex) => { stats.calls++; return key(w, path).sign({ hash: prehash }); };
