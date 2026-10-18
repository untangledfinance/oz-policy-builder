// Closes executed Squads transactions and proposals of the two 10-08 Smart Accounts: the rent returns to the payer (the stored rent collector). No votes needed.
import { PublicKey } from '@solana/web3.js';
import * as sa from '@sqds/smart-account';
import { readFileSync } from 'node:fs';
import { conn, payer, sendTx, sleep, balance, SOL } from './dev.ts';
const st = JSON.parse(readFileSync('/home/ubuntu/work/prime-refine/logs/solana-devnet/state-psn-devnet-main.json', 'utf8'));
const DRY = !!process.env.DRY;
console.log('payer before', (await balance(payer.publicKey)) / SOL);
for (const [n, s, top] of [['A', st.settings, 10], ['B', st.settingsB, 1]] as const) {
  const settings = new PublicKey(s);
  for (let i = 1n; i <= BigInt(top); i++) {
    await sleep(200);
    const pa = await conn.getAccountInfo(sa.getProposalPda({ settingsPda: settings, transactionIndex: i })[0]); if (!pa) continue;
    const status = (sa.accounts.Proposal.fromAccountInfo(pa)[0] as any).status.__kind; if (status !== 'Executed') { console.log(n, i, 'skip', status); continue; }
    const ta = (await conn.getAccountInfo(sa.getTransactionPda({ settingsPda: settings, transactionIndex: i })[0]))!;
    let isVault = true; try { sa.accounts.Transaction.fromAccountInfo(ta); } catch { isVault = false; }
    const args = { settingsPda: settings, transactionRentCollector: payer.publicKey, transactionIndex: i };
    const ixn = isVault ? sa.instructions.closeTransaction(args) : sa.instructions.closeSettingsTransaction(args);
    try {
      if (DRY) { const t = new (await import('@solana/web3.js')).Transaction().add(ixn); t.feePayer = payer.publicKey; t.recentBlockhash = (await conn.getLatestBlockhash()).blockhash; const r = await conn.simulateTransaction(t); console.log(n, i, isVault ? 'vault' : 'settings', 'sim', r.value.err ?? 'ok'); continue; }
      await sendTx(`close executed ${isVault ? 'vault' : 'settings'} transaction ${n}#${i}`, [ixn], []); console.log(n, i, 'closed');
    } catch (e: any) { console.log(n, i, 'FAILED', String(e.message).slice(0, 200)); }
  }
}
console.log('payer after', (await balance(payer.publicKey)) / SOL);
