// Prints the full errors behind the two Solana refusals whose reason logged as [object Object] (G-*4, G12).
import { Connection, Ed25519Program, Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction, TransactionInstruction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { payer } from './keys.ts';
const conn = new Connection('http://127.0.0.1:8899', 'confirmed');
const PROG = new PublicKey('FTNMFWiECbRp7D5MwJUiNQfee6NuJPjE7S11J9yc2B9G');
const show = (e: any) => JSON.stringify({ message: e?.message, logs: e?.logs ?? e?.transactionLogs, err: e?.transactionError ?? e?.error ?? e }, null, 0).slice(0, 700);
const owner = nacl.sign.keyPair(), key = Keypair.generate();
const pda = PublicKey.findProgramAddressSync([Buffer.from('prime'), Buffer.from(owner.publicKey)], PROG)[0];
const until = Math.floor(Date.now() / 1000) + 3600;
const text = `Prime session\nsigner: ${pda.toBase58()}\nsession key: ${key.publicKey.toBase58()}\nvalid until (unix time): ${until}\ncluster: localnet\nprogram: ${PROG.toBase58()}`;
const edIx = Ed25519Program.createInstructionWithPublicKey({ publicKey: owner.publicKey, message: Buffer.from(text), signature: nacl.sign.detached(Buffer.from(text), owner.secretKey) });
const exec = new TransactionInstruction({ programId: PROG, data: Buffer.concat([Buffer.from([0]), Buffer.from(owner.publicKey), Buffer.from(new BigInt64Array([BigInt(until)]).buffer), Buffer.from([0])]),
  keys: [{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }, { pubkey: key.publicKey, isSigner: true, isWritable: true }, { pubkey: pda, isSigner: false, isWritable: false },
    { pubkey: new PublicKey('SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG'), isSigner: false, isWritable: false }] });
async function trySend(label: string, ixs: TransactionInstruction[], signers: Keypair[]) {
  const tx = new Transaction().add(...ixs); tx.feePayer = signers[0]!.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash; tx.sign(...signers);
  try { const s = await conn.sendRawTransaction(tx.serialize()); console.log(label, 'SENT (unexpected)', s); } catch (e: any) { console.log(label, show(e)); }
}
// G-*4: the session key, never funded, pays the fee itself.
await trySend('G4 (unfunded session key pays the fee):', [edIx, exec], [key]);
// G12: same grant, but the ed25519 instruction reads its public key from instruction 1 instead of itself (0xffff).
const d = Buffer.from(edIx.data); d.writeUInt16LE(1, 8);
const sig = await conn.requestAirdrop(key.publicKey, 0.05 * LAMPORTS_PER_SOL);
for (let i = 0; i < 60 && !(await conn.getSignatureStatus(sig)).value?.confirmationStatus; i++) await new Promise((r) => setTimeout(r, 500));
await trySend('G12 (ed25519 public key read from another instruction):', [new TransactionInstruction({ ...edIx, data: d }), exec], [key]);
// Control: the untampered grant gets past the signature checks (it then fails later, at the Smart Account call with no accounts).
await trySend('control (untampered grant):', [edIx, exec], [key]);
process.exit(0);
