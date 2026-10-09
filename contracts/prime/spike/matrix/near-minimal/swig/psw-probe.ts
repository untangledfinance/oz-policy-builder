// Probe: can a Swig wallet sign a Squads synchronous policy execution as a policy signer? (run from /home/ubuntu/work/swig-spike)
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import * as sa from '@sqds/smart-account';
import { Actions, createSecp256k1AuthorityInfo, createSecp256k1SessionAuthorityInfo, getAddAuthorityInstructions, fetchSwig, findSwigPda, getCreateSessionInstructions, getCreateSwigInstruction, getSignInstructions,
  getSwigWalletAddress, getEvmPersonalSignPrefix } from '@swig-wallet/classic';
import { hexToBytes } from 'viem';
import { payer, B, C, phantom, metamask } from './keys.ts';

const conn = new Connection('http://127.0.0.1:8919', 'confirmed');
const SOL = LAMPORTS_PER_SOL;
const ix = sa.instructions;
const ALL = { mask: 7 };
const VENUE = Keypair.generate().publicKey, DEST = Keypair.generate().publicKey;
async function send(name: string, ixs: TransactionInstruction[], signers: Keypair[]) {
  try { const s = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: 'confirmed' }); console.log('OK  ', name, s.slice(0, 16)); return s; }
  catch (e: any) { let l = ''; try { l = (await e.getLogs?.(conn))?.slice(-8).join('\n    ') ?? ''; } catch {} console.log('FAIL', name, String(e.message).slice(0, 200), '\n    ' + l); return null; }
}
await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 100 * SOL));
const mmSign = async (m: Uint8Array) => ({ signature: hexToBytes(await metamask.signMessage({ message: { raw: m } })), prefix: getEvmPersonalSignPrefix(m.length) });

// Swig: one role, secp256k1 session authority (MetaMask key), may call the Smart Account program only, sessions of at most 600 slots
const id = crypto.getRandomValues(new Uint8Array(32));
await send('swig create (root: MetaMask secp256k1, ManageAuthority only)', [await getCreateSwigInstruction({ authorityInfo: createSecp256k1AuthorityInfo(hexToBytes(metamask.publicKey)), id, payer: payer.publicKey,
  actions: Actions.set().manageAuthority().get() })], [payer]);
let w = await fetchSwig(conn, findSwigPda(id)); const W = await getSwigWalletAddress(w);
await send('swig: root adds MetaMask session role (Program: Smart Account only), max 600 slots', await getAddAuthorityInstructions(w, 0, createSecp256k1SessionAuthorityInfo(hexToBytes(metamask.publicKey), 600n),
  Actions.set().programLimit({ programId: sa.PROGRAM_ID }).get(), { payer: payer.publicKey, currentSlot: BigInt(await conn.getSlot()), signingFn: mmSign }), [payer]);
await send('fund swig wallet address (rent minimum)', [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: W, lamports: 890_880 })], [payer]);
w = await fetchSwig(conn, findSwigPda(id));
console.log('swig', findSwigPda(id).toBase58(), 'wallet', W.toBase58(), 'roles', w.roles.length);

// Smart Account with plain-key seats B, C, phantom; policy signer = the Swig wallet address only
const pc = await sa.accounts.ProgramConfig.fromAccountAddress(conn, sa.getProgramConfigPda({})[0]);
const [settings] = sa.getSettingsPda({ accountIndex: BigInt(pc.smartAccountIndex.toString()) + 1n });
const vault = sa.getSmartAccountPda({ settingsPda: settings, accountIndex: 0 })[0];
await send('smart account', [ix.createSmartAccount({ treasury: pc.treasury, creator: payer.publicKey, settings, settingsAuthority: null, threshold: 2, timeLock: 0, rentCollector: null,
  signers: [B, C, phantom].map((k) => ({ key: k.publicKey, permissions: ALL })) }), SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vault, lamports: 2 * SOL })], [payer]);
const policyPayload: any = { __kind: 'ProgramInteraction', fields: [{ accountIndex: 0, preHook: null, postHook: null,
  instructionsConstraints: [{ programId: SystemProgram.programId, accountConstraints: [{ accountIndex: 1, accountConstraint: { __kind: 'Pubkey', fields: [[VENUE]] }, owner: null }],
    dataConstraints: [{ dataOffset: 0, dataValue: { __kind: 'U32Le', fields: [2] }, operator: sa.generated.DataOperator.Equals },
      { dataOffset: 4, dataValue: { __kind: 'U64Le', fields: [0.05 * SOL] }, operator: sa.generated.DataOperator.LessThanOrEqualTo }] }],
  spendingLimits: [{ mint: PublicKey.default, timeConstraints: { start: 0, expiration: null, period: { __kind: 'Daily' } }, quantityConstraints: { maxPerPeriod: 0.1 * SOL } }] }] };
const seed = 1; const policy = sa.getPolicyPda({ settingsPda: settings, policySeed: seed })[0];
const action: any = { __kind: 'PolicyCreate', seed, policyCreationPayload: policyPayload, signers: [{ key: W, permissions: ALL }], threshold: 1, timeLock: 0, startTimestamp: null, expirationArgs: null };
await send('settings tx + proposal + B approves', [ix.createSettingsTransaction({ settingsPda: settings, transactionIndex: 1n, creator: B.publicKey, rentPayer: payer.publicKey, actions: [action] }),
  ix.createProposal({ settingsPda: settings, transactionIndex: 1n, creator: B.publicKey, rentPayer: payer.publicKey }), ix.approveProposal({ settingsPda: settings, transactionIndex: 1n, signer: B.publicKey })], [payer, B]);
await send('C approves + executes: policy installed', [ix.approveProposal({ settingsPda: settings, transactionIndex: 1n, signer: C.publicKey }),
  ix.executeSettingsTransaction({ settingsPda: settings, transactionIndex: 1n, signer: C.publicKey, rentPayer: payer.publicKey, policies: [policy] })], [payer, C]);

// MetaMask opens a session (one personal_sign)
const sk = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(sk.publicKey, 0.05 * SOL));
w = await fetchSwig(conn, findSwigPda(id));
await send('createSession', await getCreateSessionInstructions(w, w.roles.at(-1)!.id, sk.publicKey, 300n, { currentSlot: BigInt(await conn.getSlot()), signingFn: mmSign, payer: payer.publicKey }), [payer]);
w = await fetchSwig(conn, findSwigPda(id));
const role = w.findRoleBySessionKey(sk.publicKey)!;
console.log('role', role.id, 'session key', sk.publicKey.toBase58());

const inner = SystemProgram.transfer({ fromPubkey: vault, toPubkey: VENUE, lamports: 0.01 * SOL });
const d = sa.utils.instructionsToSynchronousTransactionDetailsV2({ vaultPda: vault, members: [W], transaction_instructions: [inner] });
const move = ix.executePolicyPayloadSync({ policy, accountIndex: 0, numSigners: 1, instruction_accounts: d.accounts,
  policyPayload: { __kind: 'ProgramInteraction', fields: [{ instructionConstraintIndices: new Uint8Array([0]), transactionPayload: { __kind: 'SyncTransaction', fields: [{ accountIndex: 0, instructions: d.instructions }] } }] } });
console.log('squads accounts', move.keys.map((k) => `${k.pubkey.toBase58().slice(0, 6)}${k.isSigner ? 's' : ''}${k.isWritable ? 'w' : ''}`).join(' '));
const signIxs = await getSignInstructions(w, role.id, [move], false, { payer: sk.publicKey });
console.log('swig sign ix', signIxs.length, signIxs.map((i) => `${i.programId.toBase58().slice(0, 6)} keys=${i.keys.length} data=${i.data.length}`).join(' | '));
const before = await conn.getBalance(VENUE);
await send('MOVE: Swig session key -> Swig SignV2 -> Squads executePolicyPayloadSync (policy signer = Swig wallet)', signIxs, [sk]);
console.log('VENUE received', (await conn.getBalance(VENUE)) - before, 'lamports');
