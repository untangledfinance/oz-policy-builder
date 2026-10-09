// Signs the Solana payloads with the local test key to prove sol-verify.mjs accepts a correct signature.
import nacl from 'tweetnacl';
import { Transaction, VersionedTransaction } from '@solana/web3.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { load } from './lib/seed.mjs';
const H = '/home/ubuntu/work/wallet-matrix/real';
const P = JSON.parse(readFileSync(`${H}/payloads/solana.json`, 'utf8'));
const kp = load().sol["m/44'/501'/0'/0'"];
const sign = (t) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(t), kp.secretKey)).toString('base64');
const signLegacy = (b64) => { const tx = Transaction.from(Buffer.from(b64, 'base64')); tx.partialSign({ publicKey: { toBuffer: () => Buffer.from(kp.publicKey), toBase58: () => P.owner, equals: (o) => o.toBase58() === P.owner, toBytes: () => kp.publicKey }, secretKey: kp.secretKey }); return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'); };
const v0 = VersionedTransaction.deserialize(Buffer.from(P.v0Tx, 'base64')); v0.sign([{ publicKey: v0.message.staticAccountKeys[0], secretKey: kp.secretKey }]);
writeFileSync(`${H}/out/selftest.solana.json`, JSON.stringify({ address: P.owner, near: sign(P.nearText), grant: sign(P.grantText), legacy: signLegacy(P.legacyTx), v0: Buffer.from(v0.serialize()).toString('base64'), relayer: signLegacy(P.relayerTx) }));
