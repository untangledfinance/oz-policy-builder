// Real MetaMask (built-in Solana account) through metamask-sol/bridge.mjs: three checks, public data only.
//  1. signMessage of a grant text is a plain ed25519 signature over the UTF-8 bytes (no prefix).
//  2. signTransaction on devnet rewrites the transaction (compute unit price first, limit last) and signs the rewritten message; the fee payer slot stays empty.
//  3. signMessage over transaction message bytes does not produce a transaction signature (signed bytes = UTF-8 lossy decode with U+0000 removed).
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import nacl from 'tweetnacl'; import bs58 from 'bs58';
const BR = process.env.PSN_MM_BRIDGE ?? 'http://127.0.0.1:8830';
const call = async (b: object) => { const r = await (await fetch(BR, { method: 'POST', body: JSON.stringify(b) })).json() as any; if (r.error) throw new Error(r.error); return r; };
const addr = (await call({ method: 'address' })).address as string; const pub = bs58.decode(addr);
console.log('MetaMask Solana account', addr);
// 1
const pda = Keypair.generate().publicKey, sk = Keypair.generate().publicKey;
const text = `Prime session\nsigner: ${pda.toBase58()}\nsession key: ${sk.toBase58()}\nvalid until (unix time): ${Math.floor(Date.now() / 1000) + 3600}\ncluster: localnet`;
let t0 = Date.now(); const r1 = await call({ method: 'signMessage', hex: Buffer.from(text).toString('hex') });
console.log(`1. grant text: ${Date.now() - t0} ms, verifies over the plain UTF-8 bytes: ${nacl.sign.detached.verify(new TextEncoder().encode(text), Uint8Array.from(r1.signature), pub)}`);
// 2
const dev = new Connection('https://api.devnet.solana.com', 'confirmed');
const feePayer = new PublicKey('BrQAbGdWQ9YUHmWWgKFdFe4miTURH71jkYFPXfaosqDv');   // Squads treasury on devnet: a funded system account, only used as a fee payer in an unsigned transaction
const memo = new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [{ pubkey: new PublicKey(addr), isSigner: true, isWritable: false }], data: Buffer.from('prime native seat probe') });
const tx = new Transaction().add(memo); tx.feePayer = feePayer; tx.recentBlockhash = (await dev.getLatestBlockhash()).blockhash;
const sim = await dev.simulateTransaction(tx);
t0 = Date.now(); await call({ method: 'useScope', scope: 'solana:devnet' }).catch(() => {});
t0 = Date.now(); const r2 = await call({ method: 'signTransaction', tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), chain: 'solana:devnet' });
const ms2 = Date.now() - t0; const out = Transaction.from(Buffer.from(r2.signedTransaction, 'base64'));
const ixs = out.instructions.map((i) => `${i.programId.toBase58().slice(0, 8)}:${i.data.length}`);
const mine = out.signatures.find((s) => s.publicKey.toBase58() === addr)!;
const price = out.instructions[0]!, limit = out.instructions[out.instructions.length - 1]!;
console.log(`2. transaction: ${ms2} ms; instructions ${ixs.join(' ')}; price ${price.data.readBigUInt64LE(1)} micro-lamports; limit ${limit.data.readUInt32LE(1)} (simulated ${sim.value.unitsConsumed} + 300); fee payer signature ${out.signatures[0]!.signature ? 'present' : 'empty'}; verifies over the returned message: ${nacl.sign.detached.verify(out.serializeMessage(), mine.signature!, pub)}; over our original message: ${nacl.sign.detached.verify(tx.serializeMessage(), mine.signature!, pub)}`);
// 3
const msg = tx.serializeMessage(); const r3 = await call({ method: 'signMessage', hex: msg.toString('hex') });
const model = new TextEncoder().encode(new TextDecoder().decode(msg).replace(/\u0000/g, ''));
console.log(`3. tx message through signMessage: valid transaction signature ${nacl.sign.detached.verify(msg, Uint8Array.from(r3.signature), pub)}; verifies over the lossy-decoded, NUL-stripped bytes ${nacl.sign.detached.verify(model, Uint8Array.from(r3.signature), pub)} (${msg.length} bytes became ${model.length})`);
