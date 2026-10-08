import * as Sdk from '@stellar/stellar-sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { load } from './lib/seed.mjs';
const H = '/home/ubuntu/work/wallet-matrix/real'; const P = JSON.parse(readFileSync(`${H}/payloads/stellar.json`, 'utf8')); const kp = load().stellar;
const sha = (b) => createHash('sha256').update(b).digest();
const sg = (m) => Buffer.from(kp.sign(m)).toString('base64');
const tx = Sdk.TransactionBuilder.fromXDR(P.txXdr, P.passphrase); tx.sign(kp);
writeFileSync(`${H}/out/selftest.stellar.json`, JSON.stringify({ address: kp.publicKey(), near: sg(sha(Buffer.concat([Buffer.from('Stellar Signed Message:\n'), Buffer.from(P.nearText)]))), grant: sg(sha(Buffer.from(P.grantPreimage, 'base64'))), vote: sg(sha(Buffer.from(P.votePreimage, 'base64'))), tx: tx.toXDR() }));
