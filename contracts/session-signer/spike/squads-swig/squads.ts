// Prime Account on Solana = Squads v4 2-of-3 (rule 0) as Swig root + Swig session roles for moves.
//   members: A = owner seat: NEAR MPC ed25519 key requested by MetaMask's eth-implicit account (native NEAR,
//                no NEAR contract changes), B, C = Solana wallets. Threshold 2.
//   Swig root (role 0, all) = Squads vault PDA: Swig's ed25519 authority only checks key + is_signer, and
//   Squads signs as the vault when it executes an approved transaction.
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionMessage, sendAndConfirmTransaction, type TransactionInstruction } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import { Actions, createEd25519AuthorityInfo, createSecp256k1SessionAuthorityInfo, fetchSwig, findSwigPda, getAddAuthorityInstructions,
  getCreateSessionInstructions, getCreateSwigInstruction, getRemoveAuthorityInstructions, getSignInstructions, getSwigWalletAddress, getEvmPersonalSignPrefix } from '@swig-wallet/classic';
import { hexToBytes } from 'viem';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { payer, B, C, attacker, metamask as moverMM } from './keys.ts';

// MetaMask -> NEAR (eth-implicit, NEP-518) -> MPC ed25519: helpers from the Stellar spike, loaded from their folder.
const here = process.cwd(); process.chdir('/home/ubuntu/work/near-session-spike');
const { mpcSign, ethAccountId, metamask: ownerMM } = await import('/home/ubuntu/work/near-session-spike/mm.ts');
const { deriveEd25519 } = await import('/home/ubuntu/work/near-session-spike/near.ts');
process.chdir(here);
const A_PATH = 'prime:squads-spike/solana-1';
const A = new PublicKey(await deriveEd25519(ethAccountId, A_PATH));

const conn = new Connection(process.env.SOL_RPC ?? 'http://127.0.0.1:8899', 'confirmed');
const STATE = 'state-squads.json';
const st: any = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = () => writeFileSync(STATE, JSON.stringify(st, null, 1));
const results: any[] = st.results ?? (st.results = []);
const VENUE = new PublicKey(st.venue ?? (st.venue = Keypair.generate().publicKey.toBase58()));
const OTHER = new PublicKey(st.other ?? (st.other = Keypair.generate().publicKey.toBase58()));
const short = (e: any) => { const s = String(e?.transactionLogs?.join(' ') ?? e?.logs?.join(' ') ?? e?.message ?? e);
  const m = s.match(/(Error Code: \w+[^.]*|custom program error: 0x[0-9a-f]+|Signature verification failed|Invalid signature[^\]]*\]|missing required signature[^"]{0,40})/i); return (m?.[0] ?? s).slice(0, 150); };
function record(name: string, expectOk: boolean, ok: boolean, detail: string, ms = 0) {
  const pass = ok === expectOk; results.push({ name, pass, ok, ms, detail }); save();
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} | ${ok ? `ok ${ms ? ms + 'ms ' : ''}${detail}` : `refused: ${detail}`}`);
}
async function send(name: string, expectOk: boolean, ixs: TransactionInstruction[], signers: Keypair[]) {
  const t0 = Date.now(); let ok = true, d = '';
  try { d = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: 'confirmed' }); }
  catch (e: any) { ok = false; d = short(e); if (e?.getLogs) try { d = short({ logs: await e.getLogs(conn) }); } catch {} }
  record(name, expectOk, ok, d, Date.now() - t0); return ok;
}
/** A tx that member A must sign: A's signature comes from NEAR MPC, requested by MetaMask (one prompt). */
async function sendWithA(name: string, expectOk: boolean, ixs: TransactionInstruction[]) {
  const tx = new Transaction().add(...ixs); tx.feePayer = payer.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  const msg = tx.serializeMessage();
  const { sig, ms, nearTx } = await mpcSign(msg, A_PATH);
  console.log(`   MetaMask -> NEAR MPC signed ${msg.length} bytes for A in ${(ms / 1000).toFixed(1)}s (NEAR tx ${nearTx})`);
  tx.addSignature(A, Buffer.from(sig)); tx.partialSign(payer);
  const t0 = Date.now(); let ok = true, d = '';
  try { d = await conn.sendRawTransaction(tx.serialize()); await conn.confirmTransaction(d, 'confirmed'); const s = await conn.getSignatureStatus(d); if (s.value?.err) { ok = false; d = JSON.stringify(s.value.err); } }
  catch (e: any) { ok = false; d = short(e); }
  record(name, expectOk, ok, d, Date.now() - t0); return ok;
}
const transfer = (from: PublicKey, to: PublicKey, lamports: number) => SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });
const ms = () => new PublicKey(st.multisig);
const vault = () => multisig.getVaultPda({ multisigPda: ms(), index: 0 })[0];
const ix = multisig.instructions;
const nextIndex = async () => BigInt((await multisig.accounts.Multisig.fromAccountAddress(conn, ms())).transactionIndex.toString()) + 1n;

/** Propose a vault transaction (Swig admin call signed by the vault). */
async function propose(label: string, ixs: TransactionInstruction[], creator: Keypair) {
  const index = await nextIndex();
  const message = new TransactionMessage({ payerKey: vault(), recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: ixs });
  await send(`${label}: create vault tx #${index} + proposal`, true, [
    ix.vaultTransactionCreate({ multisigPda: ms(), transactionIndex: index, creator: creator.publicKey, vaultIndex: 0, ephemeralSigners: 0, transactionMessage: message, rentPayer: payer.publicKey }),
    ix.proposalCreate({ multisigPda: ms(), transactionIndex: index, creator: creator.publicKey, rentPayer: payer.publicKey }),
  ], [payer, creator]);
  return index;
}
const approveIx = (index: bigint, member: PublicKey) => ix.proposalApprove({ multisigPda: ms(), transactionIndex: index, member });
const executeVault = async (name: string, expectOk: boolean, index: bigint, member: Keypair) => {
  const { instruction, lookupTableAccounts } = await ix.vaultTransactionExecute({ connection: conn, multisigPda: ms(), transactionIndex: index, member: member.publicKey });
  return send(name, expectOk, [instruction], [payer, member]);
};
const swigOf = async () => fetchSwig(conn, new PublicKey(st.swig));
const mmSign = async (m: Uint8Array) => ({ signature: hexToBytes(await moverMM.signMessage({ message: { raw: m } })), prefix: getEvmPersonalSignPrefix(m.length) });
const slot = async () => BigInt(await conn.getSlot('finalized'));

const part = process.argv[2];
if (part === 'setup') {
  console.log('A (owner seat) = NEAR MPC key of', ethAccountId, A_PATH, '=', A.toBase58(), '| owner MetaMask', ownerMM.address);
  if (!st.multisig) {
    const createKey = Keypair.generate();
    const [msPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
    const pc = await multisig.accounts.ProgramConfig.fromAccountAddress(conn, multisig.getProgramConfigPda({})[0]);
    const all = multisig.types.Permissions.all();
    await send('Q1. create Squads multisig: members A (MetaMask via NEAR), B, C; threshold 2', true, [ix.multisigCreateV2({
      treasury: pc.treasury, createKey: createKey.publicKey, creator: payer.publicKey, multisigPda: msPda, configAuthority: null, threshold: 2,
      members: [{ key: A, permissions: all }, { key: B.publicKey, permissions: all }, { key: C.publicKey, permissions: all }], timeLock: 0, rentCollector: null })], [payer, createKey]);
    st.multisig = msPda.toBase58(); save();
  }
  st.vault = vault().toBase58(); save();
  if (!st.swig) {
    const id = crypto.getRandomValues(new Uint8Array(32)); st.swigId = Buffer.from(id).toString('hex');
    await send('Q2. create Swig: root (all) = Squads vault', true, [await getCreateSwigInstruction({ authorityInfo: createEd25519AuthorityInfo(vault()), id, payer: payer.publicKey, actions: Actions.set().all().get() })], [payer]);
    st.swig = findSwigPda(id).toBase58(); const swig = await swigOf(); st.wallet = (await getSwigWalletAddress(swig)).toBase58(); save();
    await send('Q2b. fund vault (rent for admin changes) and Swig wallet', true, [transfer(payer.publicKey, vault(), 0.2 * LAMPORTS_PER_SOL), transfer(payer.publicKey, new PublicKey(st.wallet), 0.2 * LAMPORTS_PER_SOL)], [payer]);
  }
  console.log({ multisig: st.multisig, vault: st.vault, swig: st.swig, wallet: st.wallet });
}
if (part === 'admin') {
  const swig = await swigOf(); const wallet = new PublicKey(st.wallet);
  // Direct attempts: no single key is Swig's root.
  await send('Q3. B alone signs a Swig admin call on role 0', false,
    await getAddAuthorityInstructions(swig, 0, createEd25519AuthorityInfo(attacker.publicKey), Actions.set().all().get(), { payer: payer.publicKey }).then((ixs) => ixs.map((i) => { i.keys = i.keys.map((k) => k.pubkey.equals(vault()) ? { ...k, pubkey: B.publicKey } : k); return i; })), [payer, B]);
  // Proposal 1: add a MetaMask SESSION mover role (VENUE only, 0.05 SOL). Approved by A (MetaMask via NEAR) + B.
  const addMover = await getAddAuthorityInstructions(swig, 0, createSecp256k1SessionAuthorityInfo(hexToBytes(moverMM.publicKey), 300n),
    Actions.set().solDestinationLimit({ amount: BigInt(0.05 * LAMPORTS_PER_SOL), destination: VENUE }).get(), { payer: vault() });
  const p1 = await propose('Q4. add mover role', addMover, B);
  await send('Q4a. B approves', true, [approveIx(p1, B.publicKey)], [payer, B]);
  await executeVault('Q4b. execute with 1 of 3 approvals', false, p1, B);
  await sendWithA('Q4c. A approves (MetaMask -> NEAR MPC signature)', true, [approveIx(p1, A)]);
  await executeVault('Q4d. execute with A + B', true, p1, B);
  await executeVault('Q4e. execute the same transaction again', false, p1, B);
  st.moverRole = (await swigOf()).roles.at(-1)!.id; save();
  await send('Q5. a non-member approves a proposal', false, [approveIx(p1, attacker.publicKey)], [payer, attacker]);
  // Mover session works on its own.
  const sk = Keypair.generate(); await send('Q6. fund session key', true, [transfer(payer.publicKey, sk.publicKey, 0.01 * LAMPORTS_PER_SOL)], [payer]);
  const s2 = await swigOf();
  await send('Q6a. mover MetaMask opens a session (one personal_sign)', true, await getCreateSessionInstructions(s2, st.moverRole, sk.publicKey, 200n, { currentSlot: await slot(), signingFn: mmSign, payer: payer.publicKey }), [payer]);
  const s3 = await swigOf(); const role = s3.findRoleBySessionKey(sk.publicKey)!;
  await send('Q6b. session key alone: 0.01 SOL to VENUE', true, await getSignInstructions(s3, role.id, [transfer(wallet, VENUE, 0.01 * LAMPORTS_PER_SOL)], false, { payer: sk.publicKey }), [sk]);
  await send('Q6c. session key: 0.01 SOL elsewhere', false, await getSignInstructions(s3, role.id, [transfer(wallet, OTHER, 0.01 * LAMPORTS_PER_SOL)], false, { payer: sk.publicKey }), [sk]);
  // Proposal 2: remove the mover role, approved by B + C (owner not needed: any 2 of 3).
  const p2 = await propose('Q7. remove mover role', await getRemoveAuthorityInstructions(s3, 0, st.moverRole, { payer: vault() }), C);
  await send('Q7a. C approves', true, [approveIx(p2, C.publicKey)], [payer, C]);
  await send('Q7b. B approves', true, [approveIx(p2, B.publicKey)], [payer, B]);
  await executeVault('Q7c. execute with B + C', true, p2, C);
  console.log('   Swig roles now', (await swigOf()).roles.map((r: any) => r.id));
  await send('Q7d. old session key after its role was removed', false, await getSignInstructions(s3, role.id, [transfer(wallet, VENUE, 1000)], false, { payer: sk.publicKey }), [sk]);
}
if (part === 'rotate') {
  // Replace member C with D (e.g. C lost a device), approved by A (MetaMask via NEAR) + B.
  const D = Keypair.generate(); st.D = Array.from(D.secretKey); save();
  const index = await nextIndex();
  await send('R1. config proposal: add D, remove C', true, [
    ix.configTransactionCreate({ multisigPda: ms(), transactionIndex: index, creator: B.publicKey, rentPayer: payer.publicKey,
      actions: [{ __kind: 'AddMember', newMember: { key: D.publicKey, permissions: multisig.types.Permissions.all() } }, { __kind: 'RemoveMember', oldMember: C.publicKey }] }),
    ix.proposalCreate({ multisigPda: ms(), transactionIndex: index, creator: B.publicKey, rentPayer: payer.publicKey }),
  ], [payer, B]);
  await send('R2. B approves', true, [approveIx(index, B.publicKey)], [payer, B]);
  await sendWithA('R3. A approves (MetaMask -> NEAR MPC)', true, [approveIx(index, A)]);
  await send('R4. execute config change', true, [ix.configTransactionExecute({ multisigPda: ms(), transactionIndex: index, member: B.publicKey, rentPayer: payer.publicKey })], [payer, B]);
  const m = await multisig.accounts.Multisig.fromAccountAddress(conn, ms());
  record('R5. members are now A, B, D (threshold 2)', true, m.members.map((x: any) => x.key.toBase58()).sort().join() === [A, B.publicKey, D.publicKey].map((k) => k.toBase58()).sort().join() && m.threshold === 2, m.members.map((x: any) => x.key.toBase58().slice(0, 6)).join(','));
  // C can no longer approve; D can.
  const swig = await swigOf();
  const p = await propose('R6. probe proposal', [transfer(vault(), VENUE, 1000)], B);
  await send('R6a. removed member C approves', false, [approveIx(p, C.publicKey)], [payer, C]);
  await send('R6b. new member D approves', true, [approveIx(p, D.publicKey)], [payer, D]);
  void swig;
}
if (part === 'limit') {
  // Squads-native movers: a spending limit (VENUE only, 0.05 SOL/day) installed by a 2-of-3 config proposal.
  // Members of the limit: key B, and W = a Swig wallet owned by a MetaMask SESSION role (MetaMask moves through Swig -> Squads CPI).
  const id = crypto.getRandomValues(new Uint8Array(32));
  await send('L0. create Swig W (root = admin key)', true, [await getCreateSwigInstruction({
    authorityInfo: createEd25519AuthorityInfo(payer.publicKey), id, payer: payer.publicKey, actions: Actions.set().all().get() })], [payer]);
  let wSwig = await fetchSwig(conn, findSwigPda(id)); const W = await getSwigWalletAddress(wSwig); st.W = W.toBase58(); st.wSwig = findSwigPda(id).toBase58(); save();
  await send('L0a. W: add MetaMask SESSION role that may only call the Squads program', true,
    await getAddAuthorityInstructions(wSwig, 0, createSecp256k1SessionAuthorityInfo(hexToBytes(moverMM.publicKey), 300n), Actions.set().programLimit({ programId: multisig.PROGRAM_ID }).get(), { payer: payer.publicKey }), [payer]);
  wSwig = await fetchSwig(conn, findSwigPda(id)); const mmRoleW = wSwig.roles.at(-1)!.id;
  await send('L0b. fund W for fees/rent', true, [transfer(payer.publicKey, W, 0.02 * LAMPORTS_PER_SOL)], [payer]);
  const createKey = Keypair.generate();
  const [spendingLimit] = multisig.getSpendingLimitPda({ multisigPda: ms(), createKey: createKey.publicKey }); st.spendingLimit = spendingLimit.toBase58(); save();
  const index = await nextIndex();
  await send('L1. config proposal: add spending limit (SOL, 0.05/day, VENUE only, members B and W)', true, [
    ix.configTransactionCreate({ multisigPda: ms(), transactionIndex: index, creator: B.publicKey, rentPayer: payer.publicKey, actions: [{ __kind: 'AddSpendingLimit',
      createKey: createKey.publicKey, vaultIndex: 0, mint: PublicKey.default, amount: BigInt(0.05 * LAMPORTS_PER_SOL), period: multisig.types.Period.Day,
      members: [B.publicKey, W], destinations: [VENUE] }] }),
    ix.proposalCreate({ multisigPda: ms(), transactionIndex: index, creator: B.publicKey, rentPayer: payer.publicKey }),
  ], [payer, B]);
  await send('L1a. B approves', true, [approveIx(index, B.publicKey)], [payer, B]);
  await sendWithA('L1b. A approves (MetaMask -> NEAR MPC)', true, [approveIx(index, A)]);
  await send('L1c. execute config change', true, [ix.configTransactionExecute({ multisigPda: ms(), transactionIndex: index, member: B.publicKey, rentPayer: payer.publicKey, spendingLimits: [spendingLimit] })], [payer, B]);
  const use = (member: PublicKey, to: PublicKey, sol: number) => ix.spendingLimitUse({ multisigPda: ms(), member, spendingLimit, vaultIndex: 0, amount: sol * LAMPORTS_PER_SOL, decimals: 9, destination: to });
  await send('L2. B alone: 0.01 SOL from the vault to VENUE', true, [use(B.publicKey, VENUE, 0.01)], [payer, B]);
  await send('L3. B alone: 0.01 SOL to another address', false, [use(B.publicKey, OTHER, 0.01)], [payer, B]);
  await send('L4. B alone: 0.045 SOL to VENUE (over 0.05/day)', false, [use(B.publicKey, VENUE, 0.045)], [payer, B]);
  await send('L5. non-member uses the limit', false, [use(attacker.publicKey, VENUE, 0.001)], [payer, attacker]);
  // MetaMask: one personal_sign -> session key -> Swig W signs spending_limit_use as member W (outbound CPI).
  const sk = Keypair.generate(); await send('L6. fund session key', true, [transfer(payer.publicKey, sk.publicKey, 0.01 * LAMPORTS_PER_SOL)], [payer]);
  await send('L6a. MetaMask opens a session on W (one personal_sign)', true,
    await getCreateSessionInstructions(wSwig, mmRoleW, sk.publicKey, 200n, { currentSlot: await slot(), signingFn: mmSign, payer: payer.publicKey }), [payer]);
  const w2 = await fetchSwig(conn, findSwigPda(id)); const role = w2.findRoleBySessionKey(sk.publicKey)!;
  await send('L6b. MetaMask session -> Swig W -> Squads limit: 0.01 SOL vault -> VENUE', true,
    await getSignInstructions(w2, role.id, [use(W, VENUE, 0.01)], false, { payer: sk.publicKey }), [sk]);
  await send('L6c. same path to another address', false, await getSignInstructions(w2, role.id, [use(W, OTHER, 0.01)], false, { payer: sk.publicKey }), [sk]);
  await send('L6d. same path, total over 0.05/day', false, await getSignInstructions(w2, role.id, [use(W, VENUE, 0.035)], false, { payer: sk.publicKey }), [sk]);
  await send('L6e. session key tries a non-Squads program through W (system transfer from W)', false,
    await getSignInstructions(w2, role.id, [transfer(W, OTHER, 1000)], false, { payer: sk.publicKey }), [sk]);
}
if (part === 'exec') {
  const D = Keypair.fromSecretKey(Uint8Array.from(st.D));
  const index = await nextIndex() - 1n; // the R6 probe (vault -> VENUE 1000 lamports), already approved by D
  const before = await conn.getBalance(VENUE);
  await executeVault('X1. execute probe with only D approved', false, index, D);
  await send('X2. B approves the probe', true, [approveIx(index, B.publicKey)], [payer, B]);
  await executeVault('X3. execute with D + B (owner A not needed)', true, index, D);
  record('X4. VENUE received exactly 1000 lamports from the vault', true, (await conn.getBalance(VENUE)) - before === 1000, `${(await conn.getBalance(VENUE)) - before} lamports`);
}
