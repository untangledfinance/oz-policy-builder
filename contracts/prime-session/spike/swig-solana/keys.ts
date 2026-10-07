// Devnet-only keys for the Swig spike. Prints public info only.
import { Keypair } from '@solana/web3.js';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const F = 'secrets/keys.json';
if (!existsSync(F)) {
  const kp = () => Array.from(Keypair.generate().secretKey);
  writeFileSync(F, JSON.stringify({ payer: kp(), phantom: kp(), b: kp(), c: kp(), attacker: kp(), metamask: generatePrivateKey() }), { mode: 0o600 });
}
const k = JSON.parse(readFileSync(F, 'utf8'));
export const payer = Keypair.fromSecretKey(Uint8Array.from(k.payer));
export const phantom = Keypair.fromSecretKey(Uint8Array.from(k.phantom)); // stands in for the owner's Phantom key
export const B = Keypair.fromSecretKey(Uint8Array.from(k.b));
export const C = Keypair.fromSecretKey(Uint8Array.from(k.c));
export const attacker = Keypair.fromSecretKey(Uint8Array.from(k.attacker));
export const metamaskPk = k.metamask as `0x${string}`;
export const metamask = privateKeyToAccount(metamaskPk);
if (import.meta.main) console.log({ payer: payer.publicKey.toBase58(), phantom: phantom.publicKey.toBase58(), B: B.publicKey.toBase58(), C: C.publicKey.toBase58(), metamask: metamask.address });
