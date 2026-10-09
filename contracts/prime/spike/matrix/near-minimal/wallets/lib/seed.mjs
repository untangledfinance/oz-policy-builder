// Generates the local test seed once (secrets/wm.json, 0600) and derives public addresses (secrets/pub.json). Never prints the seed.
import { generateMnemonic, english, mnemonicToAccount } from 'viem/accounts';
import { mnemonicToSeedSync } from '@scure/bip39';
import { derivePath } from 'ed25519-hd-key';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Keypair } from '@stellar/stellar-sdk';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const H = '/home/ubuntu/work/wallet-matrix/real';
export function load() {
  if (!existsSync(`${H}/secrets/wm.json`)) writeFileSync(`${H}/secrets/wm.json`, JSON.stringify({ srp: generateMnemonic(english), pw: randomBytes(10).toString('hex') + 'Aa1!' }), { mode: 0o600 });
  const { srp, pw } = JSON.parse(readFileSync(`${H}/secrets/wm.json`, 'utf8'));
  const seed = mnemonicToSeedSync(srp);
  const evm = mnemonicToAccount(srp);
  const solKp = (path) => nacl.sign.keyPair.fromSeed(derivePath(path, Buffer.from(seed).toString('hex')).key);
  const sol = { 'm/44\'/501\'/0\'/0\'': solKp("m/44'/501'/0'/0'"), 'm/44\'/501\'/0\'': solKp("m/44'/501'/0'") };
  const stellar = Keypair.fromRawEd25519Seed(derivePath("m/44'/148'/0'", Buffer.from(seed).toString('hex')).key);
  const pub = { evm: evm.address, sol: Object.fromEntries(Object.entries(sol).map(([k, v]) => [k, bs58.encode(v.publicKey)])), stellar: stellar.publicKey() };
  writeFileSync(`${H}/secrets/pub.json`, JSON.stringify(pub, null, 1));
  return { srp, pw, evm, sol, stellar, pub };
}
if (process.argv[1].endsWith('seed.mjs')) console.log(JSON.stringify(load().pub, null, 1));
