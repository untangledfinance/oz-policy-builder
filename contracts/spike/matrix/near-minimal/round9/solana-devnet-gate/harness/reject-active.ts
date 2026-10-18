// 2-of-3 owner vote: Phantom and MetaMask (NEAR MPC) reject the active proposals left by the 10-08 refusal checks, so their rent can be closed back to the payer.
import { PublicKey, Transaction } from '@solana/web3.js';
import * as sa from '@sqds/smart-account';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';
import { conn, payer, sendTx, balance, SOL, sleep } from './dev.ts';
const { edKey, edSign, stats } = await import('/home/ubuntu/work/near-session-spike/nearsig.ts');
const st = JSON.parse(readFileSync('/home/ubuntu/work/prime-refine/logs/solana-devnet/state-psn-devnet-main.json', 'utf8'));
const phSecret = bs58.decode(JSON.parse(readFileSync('/home/ubuntu/work/phantom-spike/secrets/phantom-test.json', 'utf8')).secret);
const phKp = nacl.sign.keyPair.fromSecretKey(phSecret.length === 64 ? phSecret : nacl.sign.keyPair.fromSeed(phSecret).secretKey);
const PH = new PublicKey(phKp.publicKey), MM = new PublicKey(await edKey('MetaMask', 'prime:solana'));
const settings = new PublicKey(st.settings);
const active: bigint[] = [];
for (let i = 1n; i <= 10n; i++) { await sleep(200); const pa = await conn.getAccountInfo(sa.getProposalPda({ settingsPda: settings, transactionIndex: i })[0]); if (pa && (sa.accounts.Proposal.fromAccountInfo(pa)[0] as any).status.__kind === 'Active') active.push(i); }
console.log('active proposals of account A', active.join(','), 'payer before', (await balance(payer.publicKey)) / SOL);
const chunks = [active.slice(0, 3), active.slice(3)].filter((c) => c.length);
for (const c of chunks) {
  const ixs = c.flatMap((i) => [PH, MM].map((signer) => sa.instructions.rejectProposal({ settingsPda: settings, transactionIndex: i, signer })));
  const sig = await sendTx(`reject active proposals ${c.join(',')} of Prime Account A: Phantom + MetaMask (NEAR MPC)`, ixs, [], { sign: async (t: Transaction) => {
    const msg = t.serializeMessage(); t.addSignature(PH, Buffer.from(nacl.sign.detached(msg, phKp.secretKey))); t.addSignature(MM, Buffer.from(await edSign('MetaMask', 'prime:solana', msg))); } });
  console.log('rejected', c.join(','), sig);
}
console.log('NEAR MPC signatures', stats.calls, 'payer after', (await balance(payer.publicKey)) / SOL);
