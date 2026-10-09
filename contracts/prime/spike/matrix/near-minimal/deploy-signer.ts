// Deploys prime-near-signer to signer.<relayer account> on NEAR testnet (creates the sub-account if needed).
import { readFileSync } from 'node:fs';
import { KeyPair } from '@near-js/crypto';
import { actionCreators } from '@near-js/transactions';
import { relayer } from './mm.ts';
import { rpc } from './near.ts';
const near = JSON.parse(readFileSync('secrets/near.json', 'utf8'));
const id = `signer.${near.accountId}`;
const wasm = readFileSync('/home/ubuntu/work/prime-near-signer/target/near/prime_near_signer.wasm');
let exists = true; try { await rpc('query', { request_type: 'view_account', finality: 'final', account_id: id }); } catch { exists = false; }
const pk = KeyPair.fromString(near.secret).getPublicKey();
const actions = exists ? [actionCreators.deployContract(wasm)]
  : [actionCreators.createAccount(), actionCreators.transfer(3n * 10n ** 24n), actionCreators.addKey(pk, actionCreators.fullAccessKey()), actionCreators.deployContract(wasm)];
const out: any = await relayer.signAndSendTransaction({ receiverId: id, actions, waitUntil: 'FINAL' });
console.log(id, exists ? 'redeployed' : 'created + deployed', out.transaction_outcome?.id, JSON.stringify(out.status).slice(0, 120));
const a = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: id });
console.log('code_hash', a.code_hash);
process.exit(0);
