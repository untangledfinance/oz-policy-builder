import { PublicKey } from '@solana/web3.js';
import * as sa from '@sqds/smart-account';
import { readFileSync } from 'node:fs';
import { conn } from './dev.ts';
const st = JSON.parse(readFileSync('/home/ubuntu/work/sloc2-devnet/logs/state-psn-devnet-main.json', 'utf8'));
for (const [n, s] of [['A', st.settings], ['B', st.settingsB]]) { const a: any = await sa.accounts.Settings.fromAccountAddress(conn, new PublicKey(s)); console.log(n, 'transactionIndex', a.transactionIndex.toString(), 'staleTransactionIndex', a.staleTransactionIndex.toString(), 'policySeed', a.policySeed?.toString()); }
