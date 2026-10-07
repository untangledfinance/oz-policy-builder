// Prime on Solana: every wallet family holds a 2-of-3 seat on a Squads Smart Account.
//   A = MetaMask  -> NEAR eth-implicit account -> MPC ed25519 (no NEAR contract)
//   P = Phantom   -> native ed25519 (signs Solana txs itself)
//   F = Freighter -> SEP-53 -> NEAR wallet contract account 0s2ee0a8… -> MPC ed25519
// Each approval is a separate signature by one wallet (proposal flow), as owners sign at different times.
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionMessage, type TransactionInstruction } from '@solana/web3.js';
import * as sa from '@sqds/smart-account';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import nacl from 'tweetnacl';
import { payer, phantom, attacker } from './keys.ts';

const here = process.cwd(); process.chdir('/home/ubuntu/work/near-session-spike');
const { mpcSign: mmMpcSign, ethAccountId } = await import('/home/ubuntu/work/near-session-spike/mm.ts');
const { deriveEd25519 } = await import('/home/ubuntu/work/near-session-spike/near.ts');
process.chdir(here);

const conn = new Connection('http://127.0.0.1:8899', 'confirmed');
const STATE = 'state-seats.json';
const st: any = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = () => writeFileSync(STATE, JSON.stringify(st, null, 1));
const results: any[] = st.results ?? (st.results = []);
const SOL = LAMPORTS_PER_SOL;
const DEST = new PublicKey(st.dest ?? (st.dest = Keypair.generate().publicKey.toBase58()));
const short = (e: any) => { const s = String(e?.logs?.join(' ') ?? e?.message ?? e);
  const m = s.match(/Error Code: \w+/) ?? s.match(/(custom program error: 0x[0-9a-f]+|Signature verification failed|[A-Za-z]+Error[^"]{0,60})/i); return (m?.[0] ?? s).slice(0, 160); };
function record(name: string, expectOk: boolean, ok: boolean, detail: string) {
  const pass = ok === expectOk; results.push({ name, pass, ok, detail }); save();
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} | ${ok ? `ok ${detail}` : `refused: ${detail}`}`);
  return ok;
}

type Wallet = { name: string; key: PublicKey; sign: (m: Uint8Array) => Promise<Uint8Array> };
const A_PATH = 'prime:sa-seats/solana-1', F_ACCT = '0s2ee0a84eed813ebcaf80280ed3c8cbad311e52d5', F_PATH = 'prime:sa-seats/freighter-1';
const A: Wallet = { name: 'MetaMask', key: new PublicKey(await deriveEd25519(ethAccountId, A_PATH)),
  sign: async (m) => { const r = await mmMpcSign(m, A_PATH); console.log(`   MetaMask -> NEAR MPC ${(r.ms / 1000).toFixed(1)}s`); return r.sig; } };
const P: Wallet = { name: 'Phantom', key: phantom.publicKey, sign: async (m) => nacl.sign.detached(m, phantom.secretKey) };
const F: Wallet = { name: 'Freighter', key: new PublicKey(await deriveEd25519(F_ACCT, F_PATH)), sign: async (m) => {
  const near = JSON.parse(readFileSync('/home/ubuntu/work/near-session-spike/secrets/near.json', 'utf8')); const t0 = Date.now();
  const out = execFileSync('/home/ubuntu/work/near-wallet-spike/intents/target/debug/examples/spike', [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NEAR_NETWORK: 'testnet', NEAR_ACCOUNT_ID: near.accountId, NEAR_PRIVATE_KEY: near.secret,
      SEP53_CODE_HASH: '5LVYEYWkNFZ9FM86Ge7RAVDjL3zzoYMfNnbRGdU2HgKQ', SPIKE_PATH: F_PATH, SPIKE_SIGN_HEX: Buffer.from(m).toString('hex') } });
  console.log(`   Freighter (SEP-53) -> NEAR wallet contract -> MPC ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return Buffer.from(out.match(/SIG ([0-9a-f]{128})/)![1]!, 'hex'); } };
const ATT: Wallet = { name: 'attacker', key: attacker.publicKey, sign: async (m) => nacl.sign.detached(m, attacker.secretKey) };

/** One tx signed by one wallet (payer pays fees). */
async function sendBy(name: string, expectOk: boolean, w: Wallet, ixs: TransactionInstruction[]) {
  const tx = new Transaction().add(...ixs); tx.feePayer = payer.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  let ok = true, d = '';
  try {
    tx.addSignature(w.key, Buffer.from(await w.sign(tx.serializeMessage()))); tx.partialSign(payer);
    d = await conn.sendRawTransaction(tx.serialize()); await conn.confirmTransaction(d, 'confirmed');
    const s = await conn.getSignatureStatus(d); if (s.value?.err) { ok = false; d = JSON.stringify(s.value.err); }
  } catch (e: any) { ok = false; d = short(e); if (e?.getLogs) try { d = short({ logs: await e.getLogs(conn) }); } catch {} }
  return record(name, expectOk, ok, d);
}
const settings = () => new PublicKey(st.settings);
const vault = () => sa.getSmartAccountPda({ settingsPda: settings(), accountIndex: 0 })[0];
const nextIndex = async () => BigInt((await sa.accounts.Settings.fromAccountAddress(conn, settings())).transactionIndex.toString()) + 1n;
const ix = sa.instructions;

/** creator proposes a vault transfer and approves it in one signature; approver approves + executes in one signature. */
async function pair(label: string, creator: Wallet, approver: Wallet | null, expectOk: boolean) {
  const index = await nextIndex();
  const message = new TransactionMessage({ payerKey: vault(), recentBlockhash: (await conn.getLatestBlockhash()).blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: vault(), toPubkey: DEST, lamports: 0.01 * SOL })] });
  await sendBy(`${label}a. ${creator.name} proposes 0.01 SOL vault -> DEST and approves (one signature)`, true, creator, [
    ix.createTransaction({ settingsPda: settings(), transactionIndex: index, creator: creator.key, rentPayer: payer.publicKey, accountIndex: 0, ephemeralSigners: 0, transactionMessage: message, addressLookupTableAccounts: [] }),
    ix.createProposal({ settingsPda: settings(), transactionIndex: index, creator: creator.key, rentPayer: payer.publicKey }),
    ix.approveProposal({ settingsPda: settings(), transactionIndex: index, signer: creator.key })]);
  const before = await conn.getBalance(DEST);
  const executor = approver ?? creator;
  const { instruction } = await ix.executeTransaction({ connection: conn, settingsPda: settings(), transactionIndex: index, signer: executor.key });
  const ixs = approver ? [ix.approveProposal({ settingsPda: settings(), transactionIndex: index, signer: approver.key }), instruction] : [instruction];
  await sendBy(`${label}b. ${approver ? `${approver.name} approves and executes` : `${creator.name} executes with only its own approval`}`, expectOk, executor, ixs);
  if (expectOk) record(`${label}c. DEST received exactly 0.01 SOL`, true, (await conn.getBalance(DEST)) - before === 0.01 * SOL, `${((await conn.getBalance(DEST)) - before) / SOL} SOL`);
  return index;
}

const part = process.argv[2];
if (part === 'setup') {
  if ((await conn.getBalance(payer.publicKey)) < 10 * SOL) await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 100 * SOL));
  console.log({ A: A.key.toBase58(), P: P.key.toBase58(), F: F.key.toBase58() });
  const pc = await sa.accounts.ProgramConfig.fromAccountAddress(conn, sa.getProgramConfigPda({})[0]);
  const [settingsPda] = sa.getSettingsPda({ accountIndex: BigInt(pc.smartAccountIndex.toString()) + 1n });
  const tx = new Transaction().add(ix.createSmartAccount({ treasury: pc.treasury, creator: payer.publicKey, settings: settingsPda, settingsAuthority: null,
    threshold: 2, timeLock: 0, rentCollector: null, signers: [A, P, F].map((w) => ({ key: w.key, permissions: { mask: 7 } })) }),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: sa.getSmartAccountPda({ settingsPda, accountIndex: 0 })[0], lamports: 1 * SOL }));
  const sig = await conn.sendTransaction(tx, [payer]); await conn.confirmTransaction(sig, 'confirmed');
  st.settings = settingsPda.toBase58(); st.vault = vault().toBase58(); save();
  record('Z0. Smart Account: seats MetaMask (A), Phantom (P), Freighter (F); threshold 2; vault funded', true, true, sig);
}
if (part === 'pairs') {
  await pair('Z1', P, null, false);
  await pair('Z2', A, P, true);
  await pair('Z3', P, F, true);
  await pair('Z4', F, A, true);
  const idx = await pair('Z5', A, null, false);
  await sendBy('Z5d. a non-member approves that proposal', false, ATT, [ix.approveProposal({ settingsPda: settings(), transactionIndex: idx, signer: ATT.key })]);
}
if (part === 'rotate') {
  // Freighter + MetaMask replace the Phantom seat (e.g. a lost device), Phantom not involved.
  const D = Keypair.generate(); const index = await nextIndex();
  await sendBy('Z6a. Freighter proposes: add D, remove Phantom; approves', true, F, [
    ix.createSettingsTransaction({ settingsPda: settings(), transactionIndex: index, creator: F.key, rentPayer: payer.publicKey,
      actions: [{ __kind: 'AddSigner', newSigner: { key: D.publicKey, permissions: { mask: 7 } } }, { __kind: 'RemoveSigner', oldSigner: P.key }] as any }),
    ix.createProposal({ settingsPda: settings(), transactionIndex: index, creator: F.key, rentPayer: payer.publicKey }),
    ix.approveProposal({ settingsPda: settings(), transactionIndex: index, signer: F.key })]);
  await sendBy('Z6b. MetaMask approves and executes the settings change', true, A, [
    ix.approveProposal({ settingsPda: settings(), transactionIndex: index, signer: A.key }),
    ix.executeSettingsTransaction({ settingsPda: settings(), transactionIndex: index, signer: A.key, rentPayer: payer.publicKey })]);
  const s = await sa.accounts.Settings.fromAccountAddress(conn, settings());
  record('Z6c. seats are now MetaMask, Freighter, D (threshold 2)', true,
    s.signers.map((x: any) => x.key.toBase58()).sort().join() === [A.key, F.key, D.publicKey].map((k) => k.toBase58()).sort().join() && s.threshold === 2,
    s.signers.map((x: any) => x.key.toBase58().slice(0, 6)).join(','));
  const idx = await nextIndex();
  const message = new TransactionMessage({ payerKey: vault(), recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: [SystemProgram.transfer({ fromPubkey: vault(), toPubkey: DEST, lamports: 1000 })] });
  await sendBy('Z7. removed Phantom seat tries to propose', false, P, [
    ix.createTransaction({ settingsPda: settings(), transactionIndex: idx, creator: P.key, rentPayer: payer.publicKey, accountIndex: 0, ephemeralSigners: 0, transactionMessage: message, addressLookupTableAccounts: [] })]);
}
if (part === 'summary') { const p = results.filter((r) => r.pass).length; console.log(`${p}/${results.length} passed`); for (const r of results.filter((r) => !r.pass)) console.log('FAIL', r.name, r.detail); }
