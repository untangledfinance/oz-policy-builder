import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { keccak256, getAddress, toHex } from 'viem';
import { base58 } from '@scure/base';
const { view, MPC } = await import('./near.ts');
const [pred, path] = process.argv.slice(2);
const root: string = await view(MPC, 'public_key', { domain_id: 0 });
const raw = base58.decode(root.split(':')[1]!); // 64 bytes x||y
const R = secp256k1.Point.fromHex('04' + Buffer.from(raw).toString('hex'));
const eps = BigInt('0x' + Buffer.from(sha3_256(new TextEncoder().encode(`near-mpc-recovery v0.1.0 epsilon derivation:${pred},${path}`))).toString('hex'));
const P = R.add(secp256k1.Point.BASE.multiply(eps % secp256k1.Point.Fn.ORDER)).toBytes(false);
console.log(root.split(':')[0], 'derived address', getAddress('0x' + keccak256(toHex(P.slice(1))).slice(26)));
