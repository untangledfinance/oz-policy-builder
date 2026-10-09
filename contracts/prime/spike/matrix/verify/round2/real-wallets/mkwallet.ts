// A fresh test recovery phrase for the real Freighter extension, and its SEP-5 Stellar key (m/44'/148'/0'),
// derived independently (SLIP-10 ed25519) so the extension's signatures can be checked against a known key.
// Writes secrets/freighter-real.json (0600). Prints the public key only.
import { generateMnemonic, mnemonicToSeedSync } from '/home/ubuntu/work/swig-spike/node_modules/@scure/bip39/index.js';
import { wordlist } from '/home/ubuntu/work/swig-spike/node_modules/@scure/bip39/wordlists/english.js';
import { createHmac } from 'node:crypto';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
const { Keypair } = await import('/home/ubuntu/work/near-session-spike/node_modules/@stellar/stellar-sdk/lib/index.js');
const F = 'secrets/freighter-real.json';
if (!existsSync(F)) {
  const mnemonic = generateMnemonic(wordlist, 128);
  const seed = mnemonicToSeedSync(mnemonic);
  let I = createHmac('sha512', 'ed25519 seed').update(seed).digest();
  let k = I.subarray(0, 32), c = I.subarray(32);
  for (const idx of [44, 148, 0]) {
    const data = Buffer.concat([Buffer.from([0]), k, Buffer.from([((idx | 0x80000000) >>> 24) & 255, ((idx | 0x80000000) >>> 16) & 255, ((idx | 0x80000000) >>> 8) & 255, (idx | 0x80000000) & 255])]);
    I = createHmac('sha512', c).update(data).digest(); k = I.subarray(0, 32); c = I.subarray(32);
  }
  const kp = Keypair.fromRawEd25519Seed(Buffer.from(k));
  writeFileSync(F, JSON.stringify({ mnemonic, public: kp.publicKey(), secret: kp.secret(), password: `Pr1me-${Math.random().toString(36).slice(2)}-Spike!` }), { mode: 0o600 });
}
console.log('Freighter test key:', JSON.parse(readFileSync(F, 'utf8')).public);
