// Freighter (key B, via A's NEAR wallet account) -> NEAR MPC -> signs a real Stellar testnet payment
// from the MPC-derived G account. The Stellar network is the independent verifier.
import { Keypair, Networks, TransactionBuilder, Operation, Asset, Horizon, xdr } from '@stellar/stellar-sdk';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const G = 'GCNVZVEYC722N4ZH5YA6IDPRPGCSVLVMTTLTQLAYZU6ICOM6RJV5BHH4'; // MPC key of A's NEAR account, path prime:freighter-spike/stellar-1
const horizon = new Horizon.Server('https://horizon-testnet.stellar.org');
const fee = Keypair.fromSecret(JSON.parse(readFileSync('secrets/fee-payer.json', 'utf8')).secret);
try { await horizon.loadAccount(G); } catch { await fetch(`https://friendbot.stellar.org?addr=${G}`); console.log('friendbot funded', G); }
const acct = await horizon.loadAccount(G);
const tx = new TransactionBuilder(acct, { fee: '1000', networkPassphrase: Networks.TESTNET })
  .addOperation(Operation.payment({ destination: fee.publicKey(), asset: Asset.native(), amount: '1' }))
  .setTimeout(300).build();
const hash = tx.hash().toString('hex');
const t = Date.now();
const out = execFileSync('/home/ubuntu/work/near-wallet-spike/intents/target/debug/examples/spike', [], {
  env: { ...process.env, SPIKE_SIGN_HEX: hash }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const sig = Buffer.from(out.match(/SIG ([0-9a-f]{128})/)![1], 'hex');
console.log(`MPC signature in ${((Date.now() - t) / 1000).toFixed(1)}s (incl. Freighter-signed NEAR request)`);
console.log('signature verifies locally against G:', Keypair.fromPublicKey(G).verify(tx.hash(), sig));
tx.signatures.push(new xdr.DecoratedSignature({ hint: Keypair.fromPublicKey(G).signatureHint(), signature: sig }));
const res = await horizon.submitTransaction(tx);
console.log('Stellar payment from MPC account accepted:', res.successful, res.hash);
