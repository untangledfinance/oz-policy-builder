// Real MetaMask on a devnet memo transaction: when does the snap leave the transaction alone? Public data only.
import { ComputeBudgetProgram, Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
const BR = 'http://127.0.0.1:8830';
const call = async (b: object) => { const r = await (await fetch(BR, { method: 'POST', body: JSON.stringify(b) })).json() as any; if (r.error) throw new Error(r.error); return r; };
const addr = new PublicKey((await call({ method: 'address' })).address);
const dev = new Connection('https://api.devnet.solana.com', 'confirmed');
const feePayer = new PublicKey('BrQAbGdWQ9YUHmWWgKFdFe4miTURH71jkYFPXfaosqDv');
const memo = () => new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [{ pubkey: addr, isSigner: true, isWritable: false }], data: Buffer.from('prime native seat probe') });
const bh = (await dev.getLatestBlockhash()).blockhash;
const build = (ixs: TransactionInstruction[]) => { const t = new Transaction().add(...ixs); t.feePayer = feePayer; t.recentBlockhash = bh; return t; };
const price = (n = 10_000) => ComputeBudgetProgram.setComputeUnitPrice({ microLamports: n }), limit = (u: number) => ComputeBudgetProgram.setComputeUnitLimit({ units: u });
const units = (await dev.simulateTransaction(build([price(), memo(), limit(1_400_000)]))).value.unitsConsumed!;   // the snap's own estimate: simulate with the budget instructions in place
// F: a transaction like a prime-session one: price, an ed25519 instruction at index 1 that the wallet's own signature over a text satisfies, the memo, limit last
import { Ed25519Program } from '@solana/web3.js';
const text = 'Prime session\nsigner: x\nsession key: y\nvalid until (unix time): 1900000000\ncluster: devnet';
const sigText = Uint8Array.from((await call({ method: 'signMessage', hex: Buffer.from(text).toString('hex') })).signature);
const ed = Ed25519Program.createInstructionWithPublicKey({ publicKey: addr.toBytes(), message: Buffer.from(text), signature: sigText });
const unitsF = (await dev.simulateTransaction(build([price(), ed, memo(), limit(1_400_000)]))).value.unitsConsumed!;
const cases: [string, Transaction, boolean][] = [
  ['A. no budget instructions, no signature (the report\'s case)', build([memo()]), false],
  ['B. no budget instructions, fee payer slot holds a signature', build([memo()]), true],
  ['C. price first and limit last already present, no signature', build([price(), memo(), limit(units)]), false],
  ['D. only a limit present, no signature', build([memo(), limit(units)]), false],
  ['E. only a price present, no signature', build([price(), memo()]), false],
  ['F. price, ed25519 instruction (index 1), memo, limit; no signature', build([price(), ed, memo(), limit(unitsF)]), false],
  ['G. ed25519 instruction first, memo, no budget instructions; no signature (what a prime-session transaction looks like before the wallet)', build([ed, memo()]), false],
];
for (const [name, tx, sig] of cases) {
  const orig = tx.serializeMessage(); if (sig) tx.signatures[0] = { publicKey: feePayer, signature: Buffer.alloc(64, 7) };
  const t0 = Date.now(); const r = await call({ method: 'signTransaction', tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), chain: 'solana:devnet' });
  const out = Transaction.from(Buffer.from(r.signedTransaction, 'base64')); const same = Buffer.compare(out.serializeMessage(), orig) === 0;
  console.log(`${name}: ${Date.now() - t0} ms; message returned ${same ? 'unchanged' : `changed (${out.instructions.length} instructions: ${out.instructions.map((i) => i.programId.toBase58().slice(0, 4)).join(' ')}${out.instructions.some((i) => i.programId.equals(Ed25519Program.programId)) ? `; the ed25519 instruction is now at index ${out.instructions.findIndex((i) => i.programId.equals(Ed25519Program.programId))}` : ''})`}; fee payer slot ${out.signatures[0]!.signature ? Buffer.from(out.signatures[0]!.signature).every((x) => x === 7) ? 'kept' : 'new' : 'empty'}`);
}
