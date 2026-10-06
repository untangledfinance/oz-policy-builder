import { ed25519 } from '@noble/curves/ed25519.js';
import { StrKey } from '@stellar/stellar-sdk';
import { mpcSign, ethAccountId } from './mm.ts';
import { deriveEd25519 } from './near.ts';
const path = 'prime:spike/stellar-1';
const pub = await deriveEd25519(ethAccountId, path);
const msg = crypto.getRandomValues(new Uint8Array(32));
const { sig, ms, nearTx } = await mpcSign(msg, path);
console.log({ admin: StrKey.encodeEd25519PublicKey(Buffer.from(pub)), ms, nearTx, valid: ed25519.verify(sig, msg, pub) });
