// 2-of-3 owner vote: Phantom and MetaMask (NEAR MPC) remove the movers policy of each 10-08 Smart Account; the policy rent returns to the payer. One transaction, one NEAR signature.
import { PublicKey, Transaction } from '@solana/web3.js';
import * as sa from '@sqds/smart-account';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';
import { conn, payer, sendTx, balance, SOL } from './dev.ts';
const { edKey, edSign, stats } = await import('/home/ubuntu/work/near-session-spike/nearsig.ts');
const st = JSON.parse(readFileSync('/home/ubuntu/work/prime-refine/logs/solana-devnet/state-psn-devnet-main.json', 'utf8'));
const phSecret = bs58.decode(JSON.parse(readFileSync('/home/ubuntu/work/phantom-spike/secrets/phantom-test.json', 'utf8')).secret);
const phKp = nacl.sign.keyPair.fromSecretKey(phSecret.length === 64 ? phSecret : nacl.sign.keyPair.fromSeed(phSecret).secretKey);
const PH = new PublicKey(phKp.publicKey), MM = new PublicKey(await edKey('MetaMask', 'prime:solana'));
console.log('payer before', (await balance(payer.publicKey)) / SOL);
const ixs = [[st.settings, st.policy], [st.settingsB, st.policyB]].map(([s, p]) => sa.instructions.executeSettingsTransactionSync({ settingsPda: new PublicKey(s), signers: [PH, MM], feePayer: payer.publicKey,
  actions: [{ __kind: 'PolicyRemove', policy: new PublicKey(p) }] as any, remainingAccounts: [{ pubkey: new PublicKey(p), isSigner: false, isWritable: true }] } as any));
const sig = await sendTx('remove the movers policies of Prime Accounts A and B (rent back to the payer): Phantom + MetaMask (NEAR MPC)', ixs, [], { sign: async (t: Transaction) => {
  const msg = t.serializeMessage(); t.addSignature(PH, Buffer.from(nacl.sign.detached(msg, phKp.secretKey))); t.addSignature(MM, Buffer.from(await edSign('MetaMask', 'prime:solana', msg))); } });
console.log('removed', sig, 'NEAR MPC signatures', stats.calls, 'payer after', (await balance(payer.publicKey)) / SOL);
