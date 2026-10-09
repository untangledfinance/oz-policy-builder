// Redeploys prime-near-signer to signer.<relayer> using the signer account's own full-access key (the relayer key is
// added to that account at creation). Run from /home/ubuntu/work/near-session-spike under the NEAR lock.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { KeyPair } from '@near-js/crypto';
import { KeyPairSigner } from '@near-js/signers';
import { Account } from '@near-js/accounts';
import { JsonRpcProvider } from '@near-js/providers';
import { actionCreators } from '@near-js/transactions';
import bs58 from 'bs58';
const { rpc, NEAR_RPC } = await import('/home/ubuntu/work/near-session-spike/near.ts');
const near = JSON.parse(readFileSync('/home/ubuntu/work/near-session-spike/secrets/near.json', 'utf8'));
const id = `signer.${near.accountId}`;
const wasm = readFileSync('/home/ubuntu/work/prime-refine/logs/near-sloc2/build/target/near/prime_near_signer.wasm');
const build = bs58.encode(createHash('sha256').update(wasm).digest());
const kp = KeyPair.fromString(near.secret);
const acct = new Account(id, new JsonRpcProvider({ url: NEAR_RPC }), new KeyPairSigner(kp));
const before = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: id });
console.log('signer', id, 'code_hash before', before.code_hash, 'build', build, 'key', kp.getPublicKey().toString());
const out: any = await acct.signAndSendTransaction({ receiverId: id, actions: [actionCreators.deployContract(wasm)], waitUntil: 'FINAL' });
console.log('deploy tx', out.transaction_outcome?.id, 'gas burnt', out.transaction_outcome?.outcome?.gas_burnt, JSON.stringify(out.status).slice(0, 80));
const after = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: id });
console.log('code_hash after', after.code_hash, 'equals build:', after.code_hash === build);
process.exit(after.code_hash === build ? 0 : 1);
