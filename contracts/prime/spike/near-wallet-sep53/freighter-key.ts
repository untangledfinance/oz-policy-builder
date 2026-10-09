// Creates a Stellar key file (Freighter stand-in). Prints only the public G address.
import { Keypair } from '@stellar/stellar-sdk';
import { existsSync, writeFileSync } from 'node:fs';
const f = process.argv[2];
if (!existsSync(f)) { const kp = Keypair.random(); writeFileSync(f, JSON.stringify({ public: kp.publicKey(), secret: kp.secret() }), { mode: 0o600 }); }
console.log(JSON.parse(require('node:fs').readFileSync(f, 'utf8')).public);
