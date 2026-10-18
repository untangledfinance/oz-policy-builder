// 2-of-3 owner vote: Phantom's local test key plus one NEAR MPC signature (MetaMask under prime:solana) send each Squads vault's balance to the payer.
// One synchronous Squads transaction per account (both signatures in one transaction). Run under: flock /home/ubuntu/work/prime-refine/near.lock bun sweep-vaults.ts
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import * as sa from '@sqds/smart-account';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';
import { conn, payer, sendTx, balance, SOL } from './dev.ts';
const { edKey, edSign, stats } = await import('/home/ubuntu/work/near-session-spike/nearsig.ts');
const st = JSON.parse(readFileSync('/home/ubuntu/work/sloc2-devnet/logs/state-psn-devnet-main.json', 'utf8'));
const phSecret = bs58.decode(JSON.parse(readFileSync('/home/ubuntu/work/phantom-spike/secrets/phantom-test.json', 'utf8')).secret);
const phKp = nacl.sign.keyPair.fromSecretKey(phSecret.length === 64 ? phSecret : nacl.sign.keyPair.fromSeed(phSecret).secretKey);
const PH = new PublicKey(phKp.publicKey), MM = new PublicKey(await edKey('MetaMask', 'prime:solana'));
const DRY = !!process.env.DRY;
console.log('payer before', (await balance(payer.publicKey)) / SOL, 'seats Phantom', PH.toBase58(), 'MetaMask(NEAR)', MM.toBase58());
for (const [n, s] of [['A', st.settings], ['B', st.settingsB]] as const) {
  const settings = new PublicKey(s), vault = sa.getSmartAccountPda({ settingsPda: settings, accountIndex: 0 })[0];
  const acc: any = await sa.accounts.Settings.fromAccountAddress(conn, settings);
  const seats = acc.signers.map((x: any) => x.key.toBase58());
  if (acc.threshold !== 2 || !seats.includes(PH.toBase58()) || !seats.includes(MM.toBase58())) throw new Error(`account ${n}: seats or threshold differ from the expected 2-of-3`);
  const v0 = await balance(vault); if (v0 === 0) { console.log(n, 'vault empty'); continue; }
  const inner = SystemProgram.transfer({ fromPubkey: vault, toPubkey: payer.publicKey, lamports: v0 });
  const d = sa.utils.instructionsToSynchronousTransactionDetailsV2({ vaultPda: vault, members: [], transaction_instructions: [inner] });
  const ixn = sa.instructions.executeTransactionSyncV2({ settingsPda: settings, accountIndex: 0, numSigners: 2, instructions: d.instructions,
    instruction_accounts: [{ pubkey: PH, isSigner: true, isWritable: false }, { pubkey: MM, isSigner: true, isWritable: false }, ...d.accounts] });
  console.log(n, 'vault', vault.toBase58(), 'balance', v0 / SOL, DRY ? '(dry)' : '');
  if (DRY) continue;
  const sig = await sendTx(`sweep vault of Prime Account ${n} (settings ${s.slice(0, 8)}...) to the payer, ${v0 / SOL} SOL: Phantom + MetaMask (NEAR MPC)`, [ixn], [], { sign: async (t: Transaction) => {
    const msg = t.serializeMessage(); t.addSignature(PH, Buffer.from(nacl.sign.detached(msg, phKp.secretKey))); t.addSignature(MM, Buffer.from(await edSign('MetaMask', 'prime:solana', msg))); } });
  console.log(n, 'swept', sig, 'vault now', (await balance(vault)) / SOL);
}
console.log('NEAR MPC signatures', stats.calls, 'payer after', (await balance(payer.publicKey)) / SOL);
