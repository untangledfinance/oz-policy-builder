// Why did W3 (Swig wallet as a Squads SETTINGS seat, proposals through a MetaMask session) fail with 0xbbe? Repeats the W3 steps and prints the program logs. Run from /home/ubuntu/work/swig-spike.
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage } from '@solana/web3.js';
import * as sa from '@sqds/smart-account';
import { Actions, createSecp256k1AuthorityInfo, createSecp256k1SessionAuthorityInfo, fetchSwig, findSwigPda, getAddAuthorityInstructions, getCreateSessionInstructions, getCreateSwigInstruction,
  getSignInstructions, getEvmPersonalSignPrefix } from '@swig-wallet/classic';
import { hexToBytes } from 'viem';
import { payer, B, C, metamask } from './keys.ts';
const conn = new Connection('http://127.0.0.1:8919', 'confirmed'); const SOL = LAMPORTS_PER_SOL; const ix = sa.instructions; const ALL = { mask: 7 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function run(name: string, ixs: TransactionInstruction[], signers: Keypair[]) {
  const tx = new Transaction().add(...ixs); tx.feePayer = signers[0]!.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash; tx.sign(...signers);
  try { const s = await conn.sendRawTransaction(tx.serialize()); for (let i = 0; i < 60; i++) { const st = (await conn.getSignatureStatus(s)).value; if (st?.err) throw Object.assign(new Error(JSON.stringify(st.err)), { signature: s }); if (st?.confirmationStatus === 'confirmed') break; await sleep(250); } console.log('OK  ', name); return true; }
  catch (e: any) { let logs: string[] = []; try { logs = e.getLogs ? await e.getLogs(conn) : (await conn.getTransaction(e.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))?.meta?.logMessages ?? []; } catch {} console.log('FAIL', name, '\n' + logs.filter((l) => /invoke|failed|Error|log:/i.test(l)).slice(-8).map((l) => '     ' + l).join('\n')); return false; }
}
await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 10 * SOL));
const mmSign = async (m: Uint8Array) => ({ signature: hexToBytes(await metamask.signMessage({ message: { raw: m } })), prefix: getEvmPersonalSignPrefix(m.length) });
const id = crypto.getRandomValues(new Uint8Array(32)); const swigPda = findSwigPda(id);
await run('swig create (root MetaMask, All)', [await getCreateSwigInstruction({ authorityInfo: createSecp256k1AuthorityInfo(hexToBytes(metamask.publicKey)), id, payer: payer.publicKey, actions: Actions.set().all().get() })], [payer]);
let w = await fetchSwig(conn, swigPda); const W = PublicKey.findProgramAddressSync([Buffer.from('swig-wallet-address'), swigPda.toBuffer()], new PublicKey('swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB'))[0];
await run('MetaMask adds its session role (Smart Account program only)', await getAddAuthorityInstructions(w, 0, createSecp256k1SessionAuthorityInfo(hexToBytes(metamask.publicKey), 300n), Actions.set().programLimit({ programId: sa.PROGRAM_ID }).get(), { payer: payer.publicKey, currentSlot: BigInt(await conn.getSlot()), signingFn: mmSign }), [payer]);
const pc = await sa.accounts.ProgramConfig.fromAccountAddress(conn, sa.getProgramConfigPda({})[0]);
const [s2] = sa.getSettingsPda({ accountIndex: BigInt(pc.smartAccountIndex.toString()) + 1n }); const v2 = sa.getSmartAccountPda({ settingsPda: s2, accountIndex: 0 })[0];
await run('Smart Account with the Swig wallet W, B, C as settings signers; threshold 2', [ix.createSmartAccount({ treasury: pc.treasury, creator: payer.publicKey, settings: s2, settingsAuthority: null, threshold: 2, timeLock: 0, rentCollector: null,
  signers: [W, B.publicKey, C.publicKey].map((key) => ({ key, permissions: ALL })) }), SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: v2, lamports: SOL }), SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: W, lamports: 0.1 * SOL })], [payer]);
const sk = Keypair.generate(); await conn.confirmTransaction(await conn.requestAirdrop(sk.publicKey, 0.05 * SOL));
w = await fetchSwig(conn, swigPda);
await run('MetaMask starts a session on W', await getCreateSessionInstructions(w, w.roles.at(-1)!.id, sk.publicKey, 200n, { currentSlot: BigInt(await conn.getSlot()), signingFn: mmSign, payer: payer.publicKey }), [payer]);
w = await fetchSwig(conn, swigPda); const role = w.findRoleBySessionKey(sk.publicKey)!;
const msg = async () => new TransactionMessage({ payerKey: v2, recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: [SystemProgram.transfer({ fromPubkey: v2, toPubkey: Keypair.generate().publicKey, lamports: 0.01 * SOL })] });
const create = async (index: bigint, rentPayer: PublicKey) => ix.createTransaction({ settingsPda: s2, transactionIndex: index, creator: W, rentPayer, accountIndex: 0, ephemeralSigners: 0, transactionMessage: await msg(), addressLookupTableAccounts: [] });
// W3 as written: session key is the rent payer (read-only signer in SignV2) and the fee payer
await run('W3a. createTransaction with the session key as rent payer, session key pays the fee', await getSignInstructions(w, role.id, [await create(1n, sk.publicKey)], false, { payer: sk.publicKey }), [sk]);
// the relayer as rent payer and fee payer (a writable outer signer)
await run('W3b. createTransaction (index 2) with the relayer as rent payer and fee payer', await getSignInstructions(w, role.id, [await create(2n, payer.publicKey)], false, { payer: sk.publicKey }), [payer, sk]);
await run('W3b2. the three W3 instructions in one Swig sign, session key as rent payer and fee payer (index 3)', await getSignInstructions(w, role.id, [await create(3n, sk.publicKey),
  ix.createProposal({ settingsPda: s2, transactionIndex: 3n, creator: W, rentPayer: sk.publicKey }), ix.approveProposal({ settingsPda: s2, transactionIndex: 3n, signer: W })], false, { payer: sk.publicKey }), [sk]);
await run('W3c. + createProposal + approveProposal as the Swig wallet, relayer pays (index 4)', await getSignInstructions(w, role.id, [await create(4n, payer.publicKey),
  ix.createProposal({ settingsPda: s2, transactionIndex: 4n, creator: W, rentPayer: payer.publicKey }), ix.approveProposal({ settingsPda: s2, transactionIndex: 4n, signer: W })], false, { payer: sk.publicKey }), [payer, sk]);
const ex = (await ix.executeTransaction({ connection: conn, settingsPda: s2, transactionIndex: 4n, signer: B.publicKey })).instruction;
await run('W4. seat B approves and executes proposal 4: 2 of 3 with the Swig wallet as one seat', [ix.approveProposal({ settingsPda: s2, transactionIndex: 4n, signer: B.publicKey }), ex], [payer, B]);
process.exit(0);
