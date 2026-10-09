// Returns the SOL left on the session keys (and the thief key) of the psn run to the payer, 6 keys per transaction. Plain local keys saved by PSN_KEYS_OUT; no NEAR.
import { Keypair, SystemProgram } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { conn, payer, sendTx, balance, sleep, SOL } from './dev.ts';
const keys = readFileSync('/home/ubuntu/work/sloc2-devnet/secrets/session-keys.jsonl', 'utf8').trim().split('\n').map((l) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(l))));
const before = await balance(payer.publicKey); let total = 0, n = 0, tx = 0;
const funded: { k: Keypair; b: number }[] = [];
for (const k of keys) { const b = await balance(k.publicKey); await sleep(200); if (b > 0) funded.push({ k, b }); }
console.log(keys.length, 'keys,', funded.length, 'with a balance');
for (let i = 0; i < funded.length; i += 6) {
  const chunk = funded.slice(i, i + 6);
  await sendTx(`return the leftover SOL of ${chunk.length} session keys to the payer`, chunk.map(({ k, b }) => SystemProgram.transfer({ fromPubkey: k.publicKey, toPubkey: payer.publicKey, lamports: b })), chunk.map((c) => c.k));
  total += chunk.reduce((s, c) => s + c.b, 0); n += chunk.length; tx++;
}
console.log(`swept ${n} keys in ${tx} transactions: ${total / SOL} SOL; payer ${before / SOL} -> ${(await balance(payer.publicKey)) / SOL}`);
