// Real Freighter signature vs freighter-sign.ts (our copy of Freighter's signMessage) for the same key and text.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const { Keypair, hash } = await import('/home/ubuntu/work/near-session-spike/node_modules/@stellar/stellar-sdk/lib/index.js');
const D = '/home/ubuntu/work/freighter-ext';
const w = JSON.parse(readFileSync(`${D}/secrets/freighter-real.json`, 'utf8'));
const [txt, sig] = process.argv.slice(2);
const text = readFileSync(txt, 'utf8'); const real = Buffer.from(readFileSync(sig, 'utf8').trim(), 'base64');
const ours = Buffer.from(execFileSync('bun', ['freighter-sign.ts', `${D}/secrets/freighter-real.json`, txt], { cwd: '/home/ubuntu/work/near-session-spike', encoding: 'utf8' }), 'base64');
const kp = Keypair.fromPublicKey(w.public);
const sep53 = hash(Buffer.concat([Buffer.from('Stellar Signed Message:\n'), Buffer.from(text)]));
console.log(JSON.stringify({ realLen: real.length, verifiesSep53: kp.verify(sep53, real), verifiesRawText: kp.verify(Buffer.from(text), real), identicalToOurCopy: real.equals(ours) }));
