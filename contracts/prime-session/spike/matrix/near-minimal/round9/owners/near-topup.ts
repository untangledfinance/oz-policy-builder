// Moves NEAR testnet funds into the relayer (approved by the orchestrator). Run from /home/ubuntu/work/near-session-spike under the NEAR lock.
import { readFileSync, readdirSync } from 'node:fs';
import { KeyPair } from '@near-js/crypto';
import { KeyPairSigner } from '@near-js/signers';
import { Account } from '@near-js/accounts';
import { JsonRpcProvider } from '@near-js/providers';
import { actionCreators } from '@near-js/transactions';
const { rpc, NEAR_RPC } = await import('/home/ubuntu/work/near-session-spike/near.ts');
const near = JSON.parse(readFileSync('secrets/near.json', 'utf8'));
const relayer = near.accountId as string, signerId = `signer.${relayer}`;
const bal = async (id: string) => { const a = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: id }); return `${(Number(BigInt(a.amount) / 10n ** 18n) / 1e6).toFixed(4)} NEAR`; };
const move = async (from: string, kp: KeyPair, near24: bigint, label: string) => {
  const acct = new Account(from, new JsonRpcProvider({ url: NEAR_RPC }), new KeyPairSigner(kp));
  const out: any = await acct.signAndSendTransaction({ receiverId: relayer, actions: [actionCreators.transfer(near24)], waitUntil: 'FINAL' });
  console.log(label, 'tx', out.transaction_outcome?.id, JSON.stringify(out.status).slice(0, 60));
};
console.log('relayer before', await bal(relayer), '| signer before', await bal(signerId));
await move(signerId, KeyPair.fromString(near.secret), 1_500_000_000_000_000_000_000_000n, `${signerId} -> relayer 1.5 NEAR`);
const dir = `${process.env.HOME}/.near-credentials/testnet`;
for (const f of readdirSync(dir).filter((n) => /^primefaucet-.*\.testnet\.json$/.test(n))) {
  const id = f.replace(/\.json$/, ''), c = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
  try { await move(id, KeyPair.fromString(c.private_key), 40_000_000_000_000_000_000_000n, `${id} -> relayer 0.04 NEAR`); } catch (e: any) { console.log(id, 'failed', String(e.message ?? e).slice(0, 120)); }
}
console.log('relayer after', await bal(relayer), '| signer after', await bal(signerId));
