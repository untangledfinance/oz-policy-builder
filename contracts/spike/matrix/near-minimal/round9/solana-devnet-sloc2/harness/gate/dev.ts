// Shared devnet helpers: paced RPC (429 back-off), payer, send/confirm, transaction log with explorer links. Devnet only.
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { appendFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
export const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('/home/ubuntu/work/swig-spike/secrets/keys.json', 'utf8')).payer));
export const LOGDIR = '/home/ubuntu/work/sloc2-devnet/logs/gate';
export const RPC = 'https://api.devnet.solana.com';
let nextSlot = 0;
const pacedFetch: typeof fetch = async (input, init) => {
  for (let attempt = 0; ; attempt++) {
    const at = Math.max(Date.now(), nextSlot); nextSlot = at + 200; await new Promise((r) => setTimeout(r, at - Date.now()));
    const res = await fetch(input, init);
    if (res.status !== 429 || attempt >= 10) return res;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
};
export const conn = new Connection(RPC, { commitment: 'confirmed', confirmTransactionInitialTimeout: 120_000, fetch: pacedFetch });
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const SOL = 1_000_000_000;
export const link = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const TXLOG = `${LOGDIR}/tx-signatures.md`;
/** Appends a transaction to the signature list (label, link). */
export const logTx = (label: string, sig: string) => appendFileSync(TXLOG, `- ${label}: [${sig.slice(0, 8)}...${sig.slice(-5)}](${link(sig)})\n`);
export async function confirm(sig: string) {
  for (let i = 0; i < 180; i++) {
    const s = (await conn.getSignatureStatus(sig, { searchTransactionHistory: true })).value;
    if (s?.err) throw Object.assign(new Error(JSON.stringify(s.err)), { signature: sig });
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return sig;
    await sleep(600);
  }
  throw new Error(`${sig} not confirmed after about 100 s`);
}
export async function sendTx(label: string, ixs: TransactionInstruction[], signers: Keypair[], o: { sign?: (t: Transaction) => Promise<void>; log?: boolean } = {}) {
  const t = new Transaction().add(...ixs); t.feePayer = payer.publicKey; t.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  if (o.sign) await o.sign(t);
  t.partialSign(payer, ...signers.filter((k) => !k.publicKey.equals(payer.publicKey)));
  const sig = await conn.sendRawTransaction(t.serialize()); await confirm(sig);
  if (o.log !== false) logTx(label, sig);
  return sig;
}
export const balance = async (a: PublicKey) => conn.getBalance(a);
