// Gives back what the custody flow can give back: burns the test tokens and closes the token accounts the flow's keys own (rent to the payer), removes the agent rule (rent to the payer)
// and sweeps custody's and the trustee's SOL to the payer. The gate account, the multisig, the mints and the settings account stay open: the programs have no close instruction for them.
import { appendFileSync, readFileSync } from 'node:fs';
import { createBurnInstruction } from '@solana/spl-token';
import * as lib from './lib-devnet.ts';
import { LOGDIR } from './dev.ts';
const { AL, conn, payer, custody, trustee, stranger, newKey, owners, send, sa, ix, Prime, viaOwners, ata, PublicKey, SystemProgram, createCloseAccountInstruction, TOKEN_PROGRAM_ID, SOL } = lib;
const st = JSON.parse(readFileSync(`${LOGDIR}/state-gate-devnet.json`, 'utf8'));
const MU = new PublicKey(st.mint), P = new Prime(owners, 2); P.settings = new PublicKey(st.prime);
const own2 = [owners[0], owners[1]];
const before = await conn.getBalance(payer.publicKey);
appendFileSync(lib.here + '../logs/solana-devnet-gate/tx-signatures.md', '\n## Clean-up\n');
const tokBal = async (a: lib.PublicKey) => { const i = await conn.getAccountInfo(a); return i ? (await lib.acct(a)).amount : null; };
async function closeOwned(label: string, account: lib.PublicKey, owner: lib.Keypair) {
  const b = await tokBal(account); if (b === null) { console.log(label, 'already closed'); return; }
  const ixs = [...(b > 0n ? [createBurnInstruction(account, MU, owner.publicKey, b)] : []), createCloseAccountInstruction(account, payer.publicKey, owner.publicKey)];
  console.log((await send(label, true, ixs, [owner], undefined, { quiet: true })).d);
}
await closeOwned('close X (owner newKey) and return its rent to the payer', new PublicKey(st.sourceAccount), newKey);
await closeOwned('close Y (owner newKey) and return its rent to the payer', new PublicKey(st.sourceAccountY), newKey);
await closeOwned('close the trustee wallet\'s token account', ata(MU, trustee.publicKey), trustee);
await closeOwned('close the stranger\'s token account', ata(MU, stranger.publicKey), stranger);
{ const v1U = ata(MU, P.vault(AL)), b = await tokBal(v1U);
  if (b !== null) {
    const w = (i: lib.TransactionInstruction) => { i.keys[i.keys.length - 1].isWritable = true; return i; };
    const inner = [...(b > 0n ? [w(createBurnInstruction(v1U, MU, P.vault(AL), b))] : []), w(createCloseAccountInstruction(v1U, payer.publicKey, P.vault(AL)))];
    console.log((await send('the owners (2 of 3) burn the tokens of the Prime vault 1 account and close it, rent to the payer', true, [viaOwners(P, own2, AL, inner)], own2, undefined, { quiet: true })).d);
  } }
{ const policy = new PublicKey(st.rule);
  if (await conn.getAccountInfo(policy)) {
    const i = ix.executeSettingsTransactionSync({ settingsPda: P.settings, signers: [owners[0].publicKey, owners[1].publicKey], feePayer: payer.publicKey, actions: [{ __kind: 'PolicyRemove', policy }] as any,
      remainingAccounts: [{ pubkey: policy, isSigner: false, isWritable: true }] } as any);
    console.log((await send('the owners (2 of 3) remove the agent rule, rent to the payer', true, [i], own2, undefined, { quiet: true })).d);
  } }
for (const [n, k] of [['custody', custody], ['the trustee', trustee]] as const) {
  const b = await conn.getBalance(k.publicKey);
  if (b > 0) console.log((await send(`sweep ${(b / SOL).toFixed(6)} SOL of ${n} to the payer`, true, [SystemProgram.transfer({ fromPubkey: k.publicKey, toPubkey: payer.publicKey, lamports: b })], [k], undefined, { quiet: true })).d);
}
const after = await conn.getBalance(payer.publicKey);
console.log(`clean-up: payer ${(before / SOL).toFixed(6)} -> ${(after / SOL).toFixed(6)} SOL (+${((after - before) / SOL).toFixed(6)})`);
st.cleanup = { beforeLamports: before, afterLamports: after }; lib.st.cleanup = st.cleanup;
