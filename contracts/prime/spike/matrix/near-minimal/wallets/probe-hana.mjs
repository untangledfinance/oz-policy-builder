import * as Sdk from '@stellar/stellar-sdk';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const H='/home/ubuntu/work/wallet-matrix/real'; const P=JSON.parse(readFileSync(`${H}/payloads/stellar.json`)); const S=JSON.parse(readFileSync(`${H}/out/hana.stellar.json`));
const kp=Sdk.Keypair.fromPublicKey(P.address); const sig=Buffer.from(S.nearRaw,'base64'); const sha=(b)=>createHash('sha256').update(b).digest();
const t=P.nearText; const B=(x)=>Buffer.from(x);
const cands={ raw:B(t), sha:sha(B(t)), sep53:sha(B('Stellar Signed Message:\n'+t)), rawPrefix:B('Stellar Signed Message:\n'+t), b64:B(B(t).toString('base64')), hex:B(B(t).toString('hex')), shaB64:sha(B(B(t).toString('base64'))), shaHex:sha(B(B(t).toString('hex'))),
 txStyle: sha(Buffer.concat([sha(B(P.passphrase)), B(t)])), sep53nl: sha(B('Stellar Signed Message:\n'+t.replace(/\n/g,' '))), trimmed:B(t.replace(/\n/g,' ')), shaTrim: sha(B(t.replace(/\n/g,' '))) };
for (const [k,m] of Object.entries(cands)) console.log(k, kp.verify(m,sig));
console.log('len', sig.length);
