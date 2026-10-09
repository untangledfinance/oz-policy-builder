// a4-min harness (mock venue): the gate-owned custody gate on a local validator at port 9101 (mainnet feature set, mainnet Squads and Token-2022 builds).
// Custody's token accounts are owned by the gate PDA (owner and close authority); custody's identity is an SPL Token multisig (custody plus a trustee). The cap is the SPL delegated amount held by
// the cap PDA; recovery signs as the owner. Every refusal is matched to the program and error that refused it, and a control shows the move is possible for the party that may make it.
// GATE_ID picks the program under test (a mutant has its own program id); GATE_SECTIONS=G,H runs only those sections; GATE_STOP_ON_FAIL=1 stops at the first failing check.
import { NATIVE_MINT, createSyncNativeInstruction, ExtensionType, getMintLen, createInitializeMintInstruction, createInitializeTransferFeeConfigInstruction, createInitializeTransferHookInstruction,
  createReallocateInstruction, createEnableCpiGuardInstruction, getAccountLen } from '@solana/spl-token';
import * as lib from './lib';
import * as sc from './setup-checks';
import { AddressLookupTableProgram, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
const { AL, OL, E, D, GATE, GATE_ID, HOSTILE, VENUE, MISSING, OWNER_MISMATCH, U, SOL, SYS, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, conn, payer, custody, backup, trustee, stranger, newKey, recovery, agent, other, owners, owners2, st, costs, save, send, must,
  check, record, mkMint, mkAcct, mkAcctKp, mkMs, mkAta, mkOwned, mkGate, setCap, ata, acct, bal, info, fmt, acts, createIx, transferIx, allowIx, releaseIx, handOver, gateAddr, capAddr, newSeed, Prime, viaOwners, viaPolicy, installRule, store, runStored, statusOf, propTime,
  pin, dc, agentKey, voteOnly, later, chainNow, until, fund, finish, sa, ix, m, FAR, i64, u64, u32, last, kp, sleep, AuthorityType, Keypair, PublicKey, SystemProgram, TransactionInstruction, createApproveInstruction, createRevokeInstruction,
  createCloseAccountInstruction, createMintToInstruction, createSetAuthorityInstruction, createTransferInstruction, createInitializeAccount3Instruction } = lib;
type Gate = lib.Gate;
const SPLIT = process.env.GATE_VARIANT !== 'thr';       // thr: the multisig's threshold changes the cap in both directions
const only = process.env.GATE_SECTIONS?.split(',');
async function section(id: string, title: string, fn: () => Promise<void>) { if (only && !only.includes(id)) return; console.log(`--- ${id}: ${title}`); await fn(); }

// ── the world: Prime Accounts, mints, custody's multisig, the venue ─────────────────────────────
const P = await new Prime(owners, 2).create(), P2 = await new Prime(owners2, 2).create(), PC = await new Prime(owners, 1, owners[0].publicKey).create();
st.P = P.settings.toBase58(); st.P2 = P2.settings.toBase58(); st.gateProgram = GATE.toBase58(); save();
const own2 = [owners[0], owners[1]], own2b = [owners[1], owners[2]], custodyBoth = [custody, trustee];
const lowerBy = SPLIT ? [custody] : custodyBoth, lowerBy2 = SPLIT ? [trustee] : custodyBoth, pks = (ks: lib.Keypair[]) => ks.map((k) => k.publicKey);
const MU = await mkMint(), MT = await mkMint(), MU22 = await mkMint(TOKEN_2022_PROGRAM_ID);
const MS = await mkMs('', [custody.publicKey, trustee.publicKey], 2);                 // custody's identity: 2-of-2, custody plus a trustee
const venuePda = PublicKey.findProgramAddressSync([Buffer.from('venue')], VENUE)[0];
const vin = ata(MU, venuePda), vinT = ata(MT, venuePda), rU = ata(MU, recovery.publicKey), sU = ata(MU, stranger.publicKey), cU = ata(MU, custody.publicKey), v1U = ata(MU, P.vault(AL));
await must('atas', [mkAta(MU, venuePda), mkAta(MT, venuePda), mkAta(MU, recovery.publicKey), mkAta(MU, stranger.publicKey), mkAta(MU, custody.publicKey), mkAta(MU, P.vault(AL))], []);
await must('venue funds', [createMintToInstruction(MU, vin, payer.publicKey, 100_000n * U), createMintToInstruction(MT, vinT, payer.publicKey, 100_000n * U)], []);
const DESTS = [venuePda, P.vault(AL)];
const paybackIx = (from: PublicKey, to: PublicKey, amount: bigint, tok = TOKEN_PROGRAM_ID) => new TransactionInstruction({ programId: VENUE, data: u64(amount), keys: [m(from, false, true), m(to, false, true), m(venuePda), m(tok)] });
const draw = async (g: Gate, src: PublicKey, dst: PublicKey, n: bigint, o: Partial<lib.Mv> = {}) => transferIx({ gate: g, lane: P.vault(AL), src, dst, amount: n * U, notAfter: await later(), ...o });
const rec = async (g: Gate, src: PublicKey, n: bigint, o: Partial<lib.Mv> = {}) => transferIx({ gate: g, lane: P.vault(OL), src, dst: rU, amount: n * U, notAfter: await later(), ...o });
const ownersDraw = async (g: Gate, src: PublicKey, dst: PublicKey, n: bigint, o: Partial<lib.Mv> = {}) => viaOwners(P, own2, AL, [await draw(g, src, dst, n, o)]);
const ownersRec = async (g: Gate, src: PublicKey, n: bigint, o: Partial<lib.Mv> = {}) => viaOwners(P, own2, OL, [await rec(g, src, n, o)]);
const vaultSigns = (i: TransactionInstruction) => { i.keys[i.keys.length - 1].isWritable = true; return i; };

await section('M', 'the multisig that is custody\'s identity', async () => {
  const ms = await mkMs('M1. custody and the trustee create a 2-of-2 SPL multisig (Token program)', [custody.publicKey, trustee.publicKey], 2, TOKEN_PROGRAM_ID, true, undefined, 'create multisig (2 signers; account creation + InitializeMultisig)');
  const a = (await conn.getAccountInfo(ms.key))!, rent = await conn.getMinimumBalanceForRentExemption(355);
  check('M2. owned by the Token program, 355 bytes, m = 2, n = 2, initialised', a.owner.equals(TOKEN_PROGRAM_ID) && a.data.length === 355 && a.data[0] === 2 && a.data[1] === 2 && a.data[2] === 1 && a.lamports === rent, `${a.data.length} B, ${rent} lamports`);
  costs['multisig account'] = { bytes: a.data.length, rent };
  await mkMs('M3. 12 signers: refused by the token program (the limit is 11)', Array.from({ length: 12 }, () => lib.gen().publicKey), 3, TOKEN_PROGRAM_ID, false, /token: custom program error: 0x7\b/);
  await mkMs('M4. m = 0: refused by the token program', [custody.publicKey, trustee.publicKey], 0, TOKEN_PROGRAM_ID, false, /token: custom program error: 0x8\b/);
  await mkMs('M5. m = 3 with 2 signers is ACCEPTED by the token program (it never checks m <= n): setup-checks and the gate must', [custody.publicKey, trustee.publicKey], 3);
  await mkMs('M6. 11 signers, m = 11: accepted (the maximum)', Array.from({ length: 11 }, () => lib.gen().publicKey), 11);
});

await section('G', 'gate creation', async () => {
  const seed0 = newSeed();
  const g = await mkGate(MS.key, P, DESTS, { seed: seed0, label: 'G1. custody (a signer of the multisig) creates the gate: Prime P, agent lane 1, owners lane 3, window 60 s, recovery R, destinations [venue, vault 1]', cost: 'create gate (2 destinations)' });
  st.G1 = g.addr.toBase58();
  { const a0 = await conn.getAccountInfo(g.addr);
    check('G1a. the gate account exists and holds at least the rent-exempt minimum for its 245 bytes', a0 !== null && a0.lamports >= (await conn.getMinimumBalanceForRentExemption(245)), `${a0?.lamports} lamports`);
    if (a0 === null) throw new Error('no gate account'); }
  { const a = (await conn.getAccountInfo(g.addr))!, d = a.data, key = (o: number) => new PublicKey(d.subarray(o, o + 32));
    check('G2. the gate account holds multisig, settings, agent lane = vault 1, owners lane = vault 3, recovery, until, window 60, seed, bump and the two destinations; 181 + 64 bytes, owned by the gate program',
      a.owner.equals(GATE) && d.length === 181 + 64 && key(0).equals(MS.key) && key(32).equals(P.settings) && key(64).equals(P.vault(AL)) && key(96).equals(P.vault(OL)) && key(128).equals(recovery.publicKey) &&
      Number(d.readBigInt64LE(160)) === FAR && d.readUInt32LE(168) === 60 && d.subarray(172, 180).equals(seed0) && key(181).equals(venuePda) && key(213).equals(P.vault(AL)), `${d.length} B`);
    costs['gate account'] = { bytes: d.length, rent: await conn.getMinimumBalanceForRentExemption(d.length) }; }
  await mkGate(MS.key, P, DESTS, { member: trustee, label: 'G3. the trustee (the other signer of the multisig) creates a gate under another seed' });
  await send('G4. a stranger (not a signer of the multisig) names it: refused', false, [createIx(stranger.publicKey, MS.key, P, [stranger.publicKey], { seed: newSeed() })], [stranger], E.wrong);
  const aM = await mkAcct(MU, MS.key);
  await send('G5. a plain token account named as the multisig: refused (no slot holds the signer)', false, [createIx(custody.publicKey, aM, P, DESTS, { seed: newSeed() })], [custody], E.wrong);
  await send('G6. custody\'s wallet (System program) named as the multisig: refused', false, [createIx(custody.publicKey, custody.publicKey, P, DESTS, { seed: newSeed() })], [custody], E.wrong);
  { const MX = await mkMs('', [stranger.publicKey, other.publicKey], 2);
    await send('G7. custody names a multisig it does not belong to (signers: stranger, other): refused', false, [createIx(custody.publicKey, MX.key, P, DESTS, { seed: newSeed() })], [custody], E.wrong);
    const Z = lib.gen();
    await must('z', [SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: Z.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(355), space: 355, programId: TOKEN_PROGRAM_ID })], [Z]);
    await send('G8. a 355-byte Token-owned account that was never initialised: refused', false, [createIx(custody.publicKey, Z.publicKey, P, DESTS, { seed: newSeed() })], [custody], E.wrong); }
  { // a lookalike multisig owned by another program, with custody in its first slot
    const fake = lib.gen(), body = Buffer.alloc(355); body[0] = 1; body[1] = 1; body[2] = 1; custody.publicKey.toBuffer().copy(body, 3);
    await must('fake', [SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: fake.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(355), space: 355, programId: HOSTILE })], [fake]);
    for (let o = 0; o < 355; o += 100) await must('fake', [new TransactionInstruction({ programId: HOSTILE, data: Buffer.concat([Buffer.from([0, o]), body.subarray(o, o + 100)]), keys: [m(fake.publicKey, false, true)] })], []);
    await send('G8b. a lookalike multisig owned by another program (custody in slot 0, m = 1, n = 1): refused, the identity must be a token program\'s multisig', false, [createIx(custody.publicKey, fake.publicKey, P, DESTS, { seed: newSeed() })], [custody], E.wrong); }
  { const M32 = await mkMs('', [custody.publicKey, trustee.publicKey], 3);
    await send('G9. a multisig with m = 3 and n = 2 (no signer set can ever release or raise): refused by the gate', false, [createIx(custody.publicKey, M32.key, P, DESTS, { seed: newSeed() })], [custody], E.wrong); }
  await send('G10. the same gate again is refused (the address is taken)', false, [createIx(custody.publicKey, MS.key, P, DESTS, { seed: seed0 })], [custody], E.inUse);
  await send('G11. a Prime Account with a settings authority is refused (that authority could add itself as an owner)', false, [createIx(custody.publicKey, MS.key, PC, DESTS, { seed: newSeed() })], [custody], E.wrong);
  { const z = lib.gen();
    await must('z', [SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: z.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(100), space: 100, programId: SYS })], [z]);
    await send('G12. a zero-filled account that Squads does not own as the settings: refused', false, [createIx(custody.publicKey, MS.key, P, DESTS, { seed: newSeed(), settings: z.publicKey })], [custody], E.wrong); }
  { const pcAcct = sa.getProgramConfigPda({})[0];
    await send('G12b. the Squads program config (owned by Squads, not a Settings account) as the settings: refused (its bytes 24 to 56 are not zero)', false, [createIx(custody.publicKey, MS.key, P, DESTS, { seed: newSeed(), settings: pcAcct })], [custody], E.wrong); }
  await send('G13. agent lane 0 (where session rules sign): refused', false, [createIx(custody.publicKey, MS.key, P, DESTS, { seed: newSeed(), agentLane: 0 })], [custody], E.invalidData);
  await send('G13b. owners lane 0: refused', false, [createIx(custody.publicKey, MS.key, P, DESTS, { seed: newSeed(), ownersLane: 0 })], [custody], E.invalidData);
  await send('G13c. both lanes the same vault: refused', false, [createIx(custody.publicKey, MS.key, P, DESTS, { seed: newSeed(), ownersLane: AL })], [custody], E.invalidData);
  await send('G14. without the signer\'s signature: refused', false, [createIx(custody.publicKey, MS.key, P, DESTS, { seed: newSeed(), signer: false })], [], E.wrong);
  await send('G15. at an address that is not the gate PDA: refused (the runtime gives the signature to the derived address only)', false, [createIx(custody.publicKey, MS.key, P, DESTS, { seed: newSeed(), gate: lib.gen().publicKey })], [custody], E.priv);
  for (const tag of [2 + 8, 4, 9]) await send(`G16. instruction tag ${tag}: there is no such instruction`, false, [new TransactionInstruction({ programId: GATE, data: Buffer.from([tag, 0, 0, 0, 0, 0, 0, 0, 0]), keys: [m(custody.publicKey, true, true)] })], [custody], E.invalidData);
  { const std = (extra: Buffer) => Buffer.concat([Buffer.from([0]), recovery.publicKey.toBuffer(), i64(FAR), u32(60), newSeed(), Buffer.from([AL, OL]), ...DESTS.map((d) => d.toBuffer()), extra]);
    await send('G16b. create data whose destination list is not whole 32-byte entries (5 stray bytes after a valid create): refused by the gate', false, [createIx(custody.publicKey, MS.key, P, DESTS, { seed: newSeed(), raw: std(Buffer.alloc(5)) })], [custody], E.gateInvalid);
    await send('G16c. create data shorter than its fixed fields (22 bytes): refused by the gate (not a panic)', false, [createIx(custody.publicKey, MS.key, P, DESTS, { seed: newSeed(), raw: Buffer.concat([Buffer.from([0]), Buffer.alloc(22)]) })], [custody], E.gateInvalid);
    await send('G16d. transfer data of 15 bytes: refused by the gate', false, [new TransactionInstruction({ programId: GATE, data: Buffer.concat([Buffer.from([1]), Buffer.alloc(15)]), keys: [m(PublicKey.default), m(P.vault(AL), false, true)] })], [], E.gateInvalid);
    await send('G16e. allow data of 7 bytes: refused by the gate', false, [new TransactionInstruction({ programId: GATE, data: Buffer.concat([Buffer.from([2]), Buffer.alloc(7)]), keys: [m(PublicKey.default)] })], [], E.gateInvalid);
    await send('G16f. release data of 31 bytes: refused by the gate', false, [new TransactionInstruction({ programId: GATE, data: Buffer.concat([Buffer.from([3]), Buffer.alloc(31)]), keys: [m(PublicKey.default)] })], [], E.gateInvalid); }
  { // lane indexes other than 1 and 3 are stored and used as given
    const gl = await mkGate(MS.key, P, DESTS, { agentLane: 2, ownersLane: 4, label: 'G20. custody creates a gate with agent lane 2 and owners lane 4' });
    const d = (await conn.getAccountInfo(gl.addr))!.data;
    check('G20b. the gate stores vault 2 as the agent lane and vault 4 as the owners lane', new PublicKey(d.subarray(64, 96)).equals(P.vault(2)) && new PublicKey(d.subarray(96, 128)).equals(P.vault(4)));
    const x = await mkOwned(gl, MU, 100n); await setCap(gl, x, 50n);
    await send('G20c. the owners as vault 2 draw 5 to the venue', true, [viaOwners(P, own2, 2, [await draw(gl, x, vin, 5n, { lane: P.vault(2) })])], own2);
    await send('G20d. vault 1 is no lane of this gate: refused', false, [viaOwners(P, own2, AL, [await draw(gl, x, vin, 1n)])], own2, E.lane);
    await send('G20e. the owners as vault 4 recover 10 to R', true, [viaOwners(P, own2, 4, [await rec(gl, x, 10n, { lane: P.vault(4) })])], own2);
    await send('G20f. vault 3 is no lane of this gate: refused', false, [viaOwners(P, own2, OL, [await rec(gl, x, 1n)])], own2, E.lane); }
  { // a stranger pre-funds the gate address before custody creates the gate: the create still works
    const s = newSeed(), addr = gateAddr(MS.key, P.settings, s);
    await send('G17. a stranger sends 1,000,000 lamports to the gate address before custody creates it', true, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: addr, lamports: 1_000_000 })], []);
    await send('G17b. custody\'s create at that address still works (Transfer, Allocate and Assign instead of CreateAccount)', true, [createIx(custody.publicKey, MS.key, P, DESTS, { seed: s })], [custody], undefined, { cost: 'create gate on a pre-funded address' });
    const a = (await conn.getAccountInfo(addr))!;
    check('G17c. the account is owned by the gate program, holds its data and is rent-exempt', a.owner.equals(GATE) && a.data.length === 245 && a.lamports >= (await conn.getMinimumBalanceForRentExemption(245)), `${a.lamports} lamports`);
    const s2 = newSeed();
    await send('G18. a stranger pre-funds another address with 5 SOL (more than the rent)', true, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: gateAddr(MS.key, P.settings, s2), lamports: 5 * SOL })], []);
    await send('G18b. custody\'s create there works and keeps the stranger\'s lamports', true, [createIx(custody.publicKey, MS.key, P, DESTS, { seed: s2 })], [custody]);
    check('G18c. the account holds at least 5 SOL', (await conn.getBalance(gateAddr(MS.key, P.settings, s2))) >= 5 * SOL); }
  { const s = newSeed(), a = await mkGate(MS.key, P, DESTS, { seed: s }), b = await mkGate(MS.key, P2, DESTS, { seed: s });
    check('G19. one multisig holds gates for two Prime Accounts and for any number of seeds: the addresses differ', a.addr.toBase58() !== b.addr.toBase58()); }
});

await section('H', 'hand-over: close authority first, then owner; custody alone is refused for everything', async () => {
  const g = await mkGate(MS.key, P, DESTS);
  const prog = TOKEN_PROGRAM_ID;
  const x = await mkAcct(MU, custody.publicKey);                       // empty, owner custody, no close authority
  await send('H1. custody hands the account to the gate: SetAuthority(CloseAccount) then SetAuthority(AccountOwner), both to the gate PDA', true, handOver(g, x, custody.publicKey), [custody], undefined, { cost: 'hand over a token account (2 SetAuthority)' });
  { const a = await acct(x);
    check('H2. owner = gate, close authority = gate, no delegate', a.owner.equals(g.addr) && a.closeAuthority?.equals(g.addr) === true && a.delegate === null, await info(x));
    check('H2b. setup-checks reads the same bytes back as clean', sc.checkHandedOver((await conn.getAccountInfo(x))!.data, g.addr).length === 0 && sc.checkSourceAccount(x, (await conn.getAccountInfo(x))!.data, prog).length === 0); }
  await must('fund', [createMintToInstruction(MU, x, payer.publicKey, 1000n * U)], []);
  { // a close authority custody set before the hand-over: it signs the first step as the close authority
    const y = await mkAcct(MU, custody.publicKey, { closeAuth: custody.publicKey, signer: custody });
    check('H3. before: custody holds the owner and a close authority of its own', (await acct(y)).closeAuthority?.equals(custody.publicKey) === true, await info(y));
    await send('H3b. the same two SetAuthority calls, signed by custody as the close authority, hand both to the gate', true, handOver(g, y, custody.publicKey), [custody]);
    check('H3c. owner = gate, close authority = gate', (await acct(y)).owner.equals(g.addr) && (await acct(y)).closeAuthority?.equals(g.addr) === true, await info(y)); }
  { // the wrong order: owner first. A close authority that was None then falls back to the owner (the gate), and nobody can set it.
    const w = await mkAcct(MU, custody.publicKey);
    await send('H4. owner first: the account goes to the gate', true, [handOver(g, w, custody.publicKey)[1]], [custody]);
    await send('H4b. then the close authority: refused (the signer must now be the gate)', false, [handOver(g, w, custody.publicKey)[0]], [custody], OWNER_MISMATCH);
    check('H4c. the close authority stays unset and falls back to the owner, the gate: custody cannot close or move it', (await acct(w)).closeAuthority === null && (await acct(w)).owner.equals(g.addr), await info(w));
    await send('H4d. custody alone cannot close it (empty)', false, [createCloseAccountInstruction(w, custody.publicKey, custody.publicKey)], [custody], OWNER_MISMATCH);
    await send('H4e. an unset close authority is no obstacle: the threshold sets a cap on it', true, [allowIx(g, w, 10n * U, pks(custodyBoth))], custodyBoth);
    await send('H4f. and releases it (the close authority is set to the new owner first: the gate signs as the owner while it is unset)', true, [releaseIx(g, w, newKey.publicKey, pks(custodyBoth))], custodyBoth);
    check('H4g. owner and close authority are newKey', (await acct(w)).owner.equals(newKey.publicKey) && (await acct(w)).closeAuthority?.equals(newKey.publicKey) === true, await info(w)); }
  const dstC = await mkAcct(MU, custody.publicKey), dstS = await mkAcct(MU, stranger.publicKey);
  const before = await bal(x);
  for (const [who, name] of [[[custody], 'custody alone'], [[trustee], 'the trustee alone'], [custodyBoth, 'custody and the trustee (the multisig threshold)'], [[stranger], 'a stranger']] as [lib.Keypair[], string][]) {
    const tag = name.startsWith('custody alone') ? 'H5' : name.startsWith('the trustee') ? 'H6' : name.startsWith('custody and') ? 'H7' : 'H8';
    const by = acts(x, who.length > 1 ? MS.key : who[0].publicKey, who.length > 1 ? who : []);
    await send(`${tag}a. ${name}: transfer out of the gate-owned account`, false, [by.transfer(dstC, 10n)], who, OWNER_MISMATCH);
    await send(`${tag}b. ${name}: approve a delegate`, false, [by.approve(stranger.publicKey, 5n)], who, OWNER_MISMATCH);
    await send(`${tag}c. ${name}: SetAuthority(AccountOwner) back to a key`, false, [by.setOwner(who[0].publicKey)], who, OWNER_MISMATCH);
    await send(`${tag}d. ${name}: SetAuthority(CloseAccount)`, false, [by.setCloser(who[0].publicKey)], who, OWNER_MISMATCH);
    await send(`${tag}e. ${name}: revoke`, false, [by.revoke()], who, OWNER_MISMATCH);
  }
  const e = await mkOwned(g, MU, 0n);
  await send('H9. custody alone: close the empty gate-owned account (lamports to itself)', false, [createCloseAccountInstruction(e, custody.publicKey, custody.publicKey)], [custody], OWNER_MISMATCH);
  await send('H9b. custody and the trustee name the multisig as the owner and sign: close refused too (the multisig is not the owner)', false, [createCloseAccountInstruction(e, custody.publicKey, MS.key, [custody.publicKey, trustee.publicKey])], custodyBoth, OWNER_MISMATCH);
  check('H10. no refused action moved anything', (await bal(x)) === before && (await bal(dstC)) === 0n && (await bal(dstS)) === 0n);
  { const d = await mkAcct(MU, custody.publicKey, { amount: 100n });
    await send('H11. before the hand-over custody approves a delegate on the account (a backdoor)', true, [acts(d, custody.publicKey, []).approve(stranger.publicKey, 500n)], [custody]);
    await send('H11b. the hand-over clears the delegate: the owner change resets delegate and allowance', true, handOver(g, d, custody.publicKey), [custody]);
    check('H11c. no delegate, allowance 0, balance intact', (await acct(d)).delegate === null && (await acct(d)).delegatedAmount === 0n && (await bal(d)) === 100n * U, await info(d));
    await send('H11d. the old delegate cannot spend', false, [createTransferInstruction(d, dstS, stranger.publicKey, 1n * U)], [stranger], OWNER_MISMATCH); }
});

await section('A', 'the cap: one signer lowers or suspends, the threshold raises', async () => {
  const g = await mkGate(MS.key, P, DESTS);
  const x = await mkOwned(g, MU, 1000n), cu = await bal(x);
  await send('A1. before any cap the agent lane cannot draw: the cap PDA is no owner and no delegate (token program refuses)', false, [await ownersDraw(g, x, vin, 5n)], own2, OWNER_MISMATCH);
  await send('A2. custody alone sets the first cap (a raise): refused, the threshold is needed', false, [allowIx(g, x, 100n * U, [custody.publicKey])], [custody], E.lane);
  await send('A2b. the trustee alone: refused', false, [allowIx(g, x, 100n * U, [trustee.publicKey])], [trustee], E.lane);
  await send('A2c. a stranger: refused', false, [allowIx(g, x, 100n * U, [stranger.publicKey])], [stranger], E.lane);
  await send('A2d. custody and a stranger (one slot filled of two): refused', false, [allowIx(g, x, 100n * U, [custody.publicKey, stranger.publicKey])], [custody, stranger], E.lane);
  await send('A2e. a signer named twice counts once: custody twice, refused', false, [allowIx(g, x, 100n * U, [custody.publicKey, custody.publicKey])], [custody], E.lane);
  { const k = allowIx(g, x, 100n * U, [custody.publicKey, trustee.publicKey]); k.keys[6].isSigner = false;
    await send('A2f. custody signs and the trustee is listed but does not sign: refused (a slot counts only when its key signs)', false, [k], [custody], E.lane); }
  await send('A3. the multisig threshold (custody and the trustee) sets the cap to 100', true, [allowIx(g, x, 100n * U, [custody.publicKey, trustee.publicKey])], custodyBoth, undefined, { cost: 'allow: threshold sets the cap (2 signers)' });
  { const a = await acct(x);
    check('A3b. the delegate is the cap PDA, 100 delegated, the gate still owns the account', a.delegate?.equals(g.cap) === true && a.delegatedAmount === 100n * U && a.owner.equals(g.addr), await info(x)); }
  await send('A4. custody alone lowers the cap to 60', SPLIT, [allowIx(g, x, 60n * U, [custody.publicKey])], [custody], SPLIT ? undefined : E.lane, { cost: 'allow: one signer lowers the cap' });
  if (!SPLIT) await send('A4a. (threshold-only variant) the threshold lowers the cap to 60', true, [allowIx(g, x, 60n * U, pks(custodyBoth))], custodyBoth, undefined, { cost: 'allow: threshold lowers the cap (2 signers)' });
  check('A4b. 60 delegated', (await acct(x)).delegatedAmount === 60n * U);
  await send('A4c. the trustee alone lowers it to 40', SPLIT, [allowIx(g, x, 40n * U, [trustee.publicKey])], [trustee], SPLIT ? undefined : E.lane);
  if (!SPLIT) await send('A4e. (threshold-only variant) the threshold lowers it to 40', true, [allowIx(g, x, 40n * U, pks(custodyBoth))], custodyBoth);
  await send('A4d. a stranger cannot lower it', false, [allowIx(g, x, 10n * U, [stranger.publicKey])], [stranger], E.lane);
  await send('A5. one signer raises 40 to 50: refused', false, [allowIx(g, x, 50n * U, [custody.publicKey])], [custody], E.lane);
  await send('A5b. the trustee alone raises it: refused', false, [allowIx(g, x, 50n * U, [trustee.publicKey])], [trustee], E.lane);
  await send('A5c. the same cap again (40 to 40) is no raise: one signer may', SPLIT, [allowIx(g, x, 40n * U, [custody.publicKey])], [custody], SPLIT ? undefined : E.lane);
  await send('A6. the threshold raises it to 100', true, [allowIx(g, x, 100n * U, custodyBoth.map((k) => k.publicKey))], custodyBoth);
  await send('A7. custody alone suspends the cap (0)', SPLIT, [allowIx(g, x, 0n, [custody.publicKey])], [custody], SPLIT ? undefined : E.lane, { cost: 'allow: one signer suspends the cap (0)' });
  if (!SPLIT) await send('A7a. (threshold-only variant) the threshold suspends the cap', true, [allowIx(g, x, 0n, pks(custodyBoth))], custodyBoth);
  check('A7b. 0 delegated, delegate still the cap PDA', (await acct(x)).delegatedAmount === 0n && (await acct(x)).delegate?.equals(g.cap) === true, await info(x));
  await send('A7c. the agent lane cannot draw while suspended (allowance 0)', false, [await ownersDraw(g, x, vin, 1n)], own2, E.funds);
  await send('A7d. the recovery lane is not stopped by the suspended cap: 30 to R (uncapped)', true, [await ownersRec(g, x, 30n)], own2, undefined, { cost: 'recovery by the owners (sync, no wait)' });
  await send('A7e. a single signer cannot lift the suspension (a raise)', false, [allowIx(g, x, 5n * U, [trustee.publicKey])], [trustee], E.lane);
  await send('A8. the threshold sets 100 again', true, [allowIx(g, x, 100n * U, custodyBoth.map((k) => k.publicKey))], custodyBoth);
  await send('A9. the cap PDA is checked: naming a stranger as the delegate account is refused (one signer would otherwise hand a delegate to any key)', false, [allowIx(g, x, 50n * U, pks(lowerBy), { capAcct: stranger.publicKey })], lowerBy, E.wrong);
  await send('A9b. the same with the threshold and a bigger cap (a raise to a stranger delegate): refused', false, [allowIx(g, x, 500n * U, custodyBoth.map((k) => k.publicKey), { capAcct: stranger.publicKey })], custodyBoth, E.wrong);
  { const MX = await mkMs('', [stranger.publicKey, other.publicKey], 2);
    await send('A10. signers of another multisig (stranger and other, 2 of 2) name their own multisig: refused, it is not the gate\'s', false, [allowIx(g, x, 10n * U, [stranger.publicKey, other.publicKey], { ms: MX.key })], [stranger, other], E.lane); }
  await send('A11. a stranger names the real multisig and signs: refused (not a slot)', false, [allowIx(g, x, 10n * U, [stranger.publicKey])], [stranger], E.lane);
  { const own = await mkAcct(MU, custody.publicKey, { amount: 10n });
    await send('A12. a source the gate does not own (custody\'s plain account): the token program refuses the Approve', false, [allowIx(g, own, 10n * U, custodyBoth.map((k) => k.publicKey))], custodyBoth, OWNER_MISMATCH); }
  await send('A13. a hostile program as the token program: refused by the allow-list', false, [allowIx(g, x, 10n * U, pks(lowerBy), { tok: HOSTILE })], lowerBy, E.wrong);
  await send('A14. a token account that is no gate of this program (another account as the gate): refused', false, [new TransactionInstruction({ programId: GATE, data: Buffer.concat([Buffer.from([2]), u64(1n)]), keys: [m(x), m(x, false, true), m(TOKEN_PROGRAM_ID), m(MS.key), m(g.cap), m(custody.publicKey, true)] })], [custody], E.wrong);
  check('A15. no allow moved a balance', (await bal(x)) === cu - 30n * U, `${fmt(await bal(x))} left`);
  // the cap is used up: the next draw is refused by the token program, never turns into an uncapped owner path
  await send('A16. the agent lane draws exactly the rest of the cap (70 left of 100 after 30 recovered; delegated stays 100)', true, [await ownersDraw(g, x, vin, 100n)], own2);
  check('A16b. the delegate is cleared by the token program, the cap is gone', (await acct(x)).delegate === null && (await acct(x)).delegatedAmount === 0n, await info(x));
  await send('A16c. the next agent draw is refused by the token program: the cap PDA is no owner, so there is no fallback to an unlimited path', false, [await ownersDraw(g, x, vin, 1n)], own2, OWNER_MISMATCH);
  await send('A16d. recovery still works after the cap is used up', true, [await ownersRec(g, x, 20n)], own2);
  await send('A16e. one signer may lower a cap that is gone (0 to 0)', SPLIT, [allowIx(g, x, 0n, [custody.publicKey])], [custody], SPLIT ? undefined : E.lane);
});

await section('T', 'the agent lane and the owners lane', async () => {
  const g = await mkGate(MS.key, P, DESTS, { window: 60 });
  const x = await mkOwned(g, MU, 1000n); await setCap(g, x, 100n);
  const v0 = await bal(vin), x0 = await bal(x);
  await send('T1. the owners at their count sign as the agent lane and draw 10 to the venue', true, [await ownersDraw(g, x, vin, 10n)], own2, undefined, { cost: 'agent lane draw, owners as the lane (sync)' });
  check('T1b. the venue gained 10, the gate-owned account lost 10, the cap fell to 90', (await bal(vin)) - v0 === 10n * U && x0 - (await bal(x)) === 10n * U && (await acct(x)).delegatedAmount === 90n * U, await info(x));
  await send('T1c. the Prime vault\'s own account (the second listed destination)', true, [await ownersDraw(g, x, v1U, 1n)], own2);
  await send('T2. to a stranger (not on the list): refused by the gate', false, [await ownersDraw(g, x, sU, 1n)], own2, E.dest);
  await send('T3. the agent lane pays the recovery address: refused (recovery is not a listed destination)', false, [await ownersDraw(g, x, rU, 1n)], own2, E.dest);
  await send('T4. over the cap (89 left, asks 95): refused by the token program', false, [await ownersDraw(g, x, vin, 95n)], own2, E.funds);
  await send('T5. a not-after that has passed: refused by the gate', false, [await ownersDraw(g, x, vin, 1n, { notAfter: (await chainNow()) - 5 })], own2, E.window);
  await send('T5b. a not-after more than the gate\'s 60 s window ahead: refused by the gate', false, [await ownersDraw(g, x, vin, 1n, { notAfter: await later(600) })], own2, E.window);
  await send('T5c. a not-after of 0 (no deadline): refused', false, [await ownersDraw(g, x, vin, 1n, { notAfter: 0 })], own2, E.window);
  await send('T5d. a not-after 50 s ahead, inside the window: allowed', true, [await ownersDraw(g, x, vin, 1n, { notAfter: await later(50) })], own2);
  await send('T6. the owners sign as vault 2 (not a lane): refused', false, [viaOwners(P, own2, 2, [await draw(g, x, vin, 1n, { lane: P.vault(2) })])], own2, E.lane);
  await send('T6b. another Prime Account\'s owners sign as their vault 1: refused', false, [viaOwners(P2, owners2.slice(0, 2), AL, [await draw(g, x, vin, 1n, { lane: P2.vault(AL) })])], owners2.slice(0, 2), E.lane);
  await send('T6c. the lane vault named without its signature: refused', false, [await draw(g, x, vin, 1n, { laneSigns: false })], [], E.lane);
  await send('T6d. custody signs as the lane: refused (custody is no lane)', false, [await draw(g, x, vin, 1n, { lane: custody.publicKey })], [custody], E.lane);
  await send('T6e. a stranger signs as the lane: refused', false, [await draw(g, x, sU, 1n, { lane: stranger.publicKey })], [stranger], E.lane);
  await send('T6f. the owners lane vault 3 as a vault of another index (vault 4 of P): refused', false, [viaOwners(P, own2, 4, [await draw(g, x, vin, 1n, { lane: P.vault(4) })])], own2, E.lane);
  await send('T7. a cap PDA that is not this gate\'s on the agent path: refused by the runtime (the gate cannot sign for it)', false, [await ownersDraw(g, x, vin, 1n, { cap: capAddr(PublicKey.default) })], own2, E.priv);
  await send('T7b. the gate itself named as the cap PDA (to sign as the owner, with no cap): refused', false, [await ownersDraw(g, x, vin, 1n, { cap: g.addr })], own2, E.priv);
  { // an account owned by the cap PDA would be paid as an owner with no limit: the gate refuses it
    const d = await mkAcct(MU, custody.publicKey, { amount: 50n });
    await send('T8. custody hands an account to the cap PDA (owner = cap PDA)', true, [acts(d, custody.publicKey, []).setOwner(g.cap)], [custody]);
    await send('T8b. the agent lane draws from it: refused by the gate (the source must be owned by the gate)', false, [await ownersDraw(g, d, vin, 5n)], own2, E.wrong);
    await send('T8c. the owners lane draws from it: refused by the token program (the gate is not its owner)', false, [await ownersRec(g, d, 5n)], own2, OWNER_MISMATCH); }
  { const fake = lib.gen(), real = (await conn.getAccountInfo(g.addr))!.data;
    await must('fake', [SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: fake.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(245), space: 245, programId: HOSTILE })], [fake]);
    const body = Buffer.concat([real.subarray(0, 64), stranger.publicKey.toBuffer(), stranger.publicKey.toBuffer(), stranger.publicKey.toBuffer(), real.subarray(160, 181), stranger.publicKey.toBuffer(), stranger.publicKey.toBuffer()]);
    for (let o = 0; o < body.length; o += 100) await must('fake', [new TransactionInstruction({ programId: HOSTILE, data: Buffer.concat([Buffer.from([0, o]), body.subarray(o, o + 100)]), keys: [m(fake.publicKey, false, true)] })], []);
    await send('T9. a forged gate account (owned by another program; the stranger as both lanes, recovery and destination): refused', false, [await draw(g, x, sU, 5n, { addr: fake.publicKey, lane: stranger.publicKey })], [stranger], E.wrong);
    await send('T9b. the same on the owners path', false, [await rec(g, x, 5n, { addr: fake.publicKey, lane: stranger.publicKey, dst: sU })], [stranger], E.wrong); }
  await send('T10. a hostile program named as the token program on the agent path: refused by the allow-list', false, [await ownersDraw(g, x, vin, 0n, { tok: HOSTILE })], own2, E.wrong);
  await send('T10b. the same on the owners path', false, [await ownersRec(g, x, 0n, { tok: HOSTILE })], own2, E.wrong);
  await send('T11. a destination that is not a token account (a wallet): refused', false, [await ownersDraw(g, x, stranger.publicKey, 1n)], own2, E.wrong);
  // the owners lane: recovery address only, at any time, not bounded by the cap
  const r0 = await bal(rU);
  await send('T12. the owners lane pays 300 to the recovery address while the cap is 88: not bounded by the cap', true, [await ownersRec(g, x, 300n)], own2, undefined, { cost: 'recovery by the owners (sync, no wait)' });
  check('T12b. R gained 300 (the cap is untouched at 88)', (await bal(rU)) - r0 === 300n * U && (await acct(x)).delegatedAmount === 88n * U, await info(x));
  await send('T13. the owners lane pays a listed venue: refused (recovery address only)', false, [await ownersRec(g, x, 1n, { dst: vin })], own2, E.dest);
  await send('T13b. the owners lane pays a stranger: refused', false, [await ownersRec(g, x, 1n, { dst: sU })], own2, E.dest);
  await send('T14. one owner alone as the owners lane (threshold 2): refused by Squads', false, [viaOwners(P, [owners[0]], OL, [await rec(g, x, 1n)])], [owners[0]], E.signers);
  await send('T15. the owners lane needs a not-after too (a stored recovery lapses): a deadline that has passed is refused', false, [await ownersRec(g, x, 1n, { notAfter: (await chainNow()) - 5 })], own2, E.window);
  await send('T16. recovery of everything left to R', true, [await ownersRec(g, x, (await bal(x)) / U)], own2);
  check('T16b. the gate-owned account is empty, R holds everything that was recovered', (await bal(x)) === 0n && (await bal(rU)) - r0 > 0n, await info(x));
});

const transferC = (g: Gate, src: PublicKey, dst: PublicKey, lo: bigint, hi: bigint) => ({ programId: g.gp, accountConstraints: [pin(0, g.addr), pin(2, src), pin(3, dst)],
  dataConstraints: [dc('U8', 0, 1, D.Equals), dc('U64Le', 1, lo * U, D.GreaterThanOrEqualTo), dc('U64Le', 1, hi * U, D.LessThanOrEqualTo), dc('U64Le', 9, 1, D.GreaterThanOrEqualTo)] });
const paybackC = (from: PublicKey, to: PublicKey, hi: bigint) => ({ programId: VENUE, accountConstraints: [pin(0, from), pin(1, to)], dataConstraints: [dc('U64Le', 0, hi * U, D.LessThanOrEqualTo)] });

await section('X', 'the close-and-reopen bypass is refused', async () => {
  const g = await mkGate(MS.key, P, DESTS);
  const ky = await mkAcctKp(MU, custody.publicKey, { amount: 50n, closeAuth: custody.publicKey, signer: custody }), y = ky.publicKey;
  check('X0. custody holds the owner and a close authority of its own on the account', (await acct(y)).closeAuthority?.equals(custody.publicKey) === true, await info(y));
  await send('X1. custody hands over the OWNER only and keeps the close authority (the bypass setup)', true, [handOver(g, y, custody.publicKey)[1]], [custody]);
  check('X1b. owner = gate, close authority = custody; setup-checks flags the read-back', (await acct(y)).owner.equals(g.addr) && sc.checkHandedOver((await conn.getAccountInfo(y))!.data, g.addr).map((i) => i.code).join() === 'close-authority-not-gate', await info(y));
  await send('X2. the multisig threshold tries to set a cap: refused by the gate (a close authority that is neither the gate nor none)', false, [allowIx(g, y, 50n * U, custodyBoth.map((k) => k.publicKey))], custodyBoth, E.wrong);
  await send('X3. with no cap the agent lane cannot draw: refused by the token program', false, [await ownersDraw(g, y, vin, 50n)], own2, OWNER_MISMATCH);
  await send('X4. custody, the close authority, cannot close the account while it holds 50', false, [createCloseAccountInstruction(y, custody.publicKey, custody.publicKey)], [custody], /token: custom program error: 0xb\b/);
  // the whole sequence the bypass needs, scripted: cap, draw the account empty, close, open the same address as custody's own, receive the venue's proceeds, move them alone
  const captured = await (async () => {
    // a fresh account in the same wrong state, so the script does not depend on the checks above
    const kz = await mkAcctKp(MU, custody.publicKey, { amount: 50n, closeAuth: custody.publicKey, signer: custody }), z = kz.publicKey;
    await must('owner only', [handOver(g, z, custody.publicKey)[1]], [custody]);
    const cap = await send('', true, [allowIx(g, z, 50n * U, custodyBoth.map((k) => k.publicKey))], custodyBoth, undefined, { quiet: true });
    if (!cap.ok) return { stage: 'cap refused', amount: 0n, detail: cap.d };
    const d1 = await send('', true, [await ownersDraw(g, z, vin, 50n)], own2, undefined, { quiet: true });
    const c1 = await send('', true, [createCloseAccountInstruction(z, custody.publicKey, custody.publicKey)], [custody], undefined, { quiet: true });
    const o1 = await send('', true, [SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: z, lamports: await conn.getMinimumBalanceForRentExemption(165), space: 165, programId: TOKEN_PROGRAM_ID }),
      createInitializeAccount3Instruction(z, MU, custody.publicKey)], [kz], undefined, { quiet: true });
    const p1 = await send('', true, [paybackIx(vin, z, 50n * U)], [], undefined, { quiet: true });
    const t1 = await send('', true, [createTransferInstruction(z, sU, custody.publicKey, 50n * U)], [custody], undefined, { quiet: true });
    return { stage: [d1, c1, o1, p1, t1].map((r) => (r.ok ? 'ok' : r.d)).join(' / '), amount: t1.ok ? 50n * U : 0n, detail: '' };
  })();
  check('X5. the bypass captures nothing: the cap cannot be set, so the account is never drawn empty and the venue pays no proceeds into an account custody can move alone', captured.amount === 0n, `${captured.stage} ${captured.detail}`);
  await send('X6. the owners recover the 50 to R (recovery works for a wrongly set up account too)', true, [await ownersRec(g, y, 50n)], own2);
  await send('X7. custody fixes the setup: it signs SetAuthority(CloseAccount) as the close authority and hands it to the gate', true, [handOver(g, y, custody.publicKey)[0]], [custody]);
  check('X7b. the read-back is clean now', sc.checkHandedOver((await conn.getAccountInfo(y))!.data, g.addr).length === 0, await info(y));
  await send('X7c. the multisig threshold sets a cap on the repaired account', true, [allowIx(g, y, 10n * U, custodyBoth.map((k) => k.publicKey))], custodyBoth);
  { const z = await mkAcct(MU, custody.publicKey, { amount: 20n });
    await send('X8. a close authority held by a stranger: custody sets it before the hand-over', true, [acts(z, custody.publicKey, []).setCloser(stranger.publicKey)], [custody]);
    await send('X8b. custody hands over the owner only (it cannot change the stranger\'s close authority)', true, [handOver(g, z, custody.publicKey)[1]], [custody]);
    await send('X8c. a cap is refused', false, [allowIx(g, z, 5n * U, custodyBoth.map((k) => k.publicKey))], custodyBoth, E.wrong);
    await send('X8d. release is refused too: the gate cannot change a close authority it does not hold (the token program refuses)', false, [releaseIx(g, z, newKey.publicKey, custodyBoth.map((k) => k.publicKey))], custodyBoth, OWNER_MISMATCH);
    await send('X8e. recovery still gets the 20 out', true, [await ownersRec(g, z, 20n)], own2); }
});

await section('E', 'the end time stops the agent lane; recovery works before and after it', async () => {
  const t = await later(14), g = await mkGate(MS.key, P, DESTS, { until: t });
  const x = await mkOwned(g, MU, 1000n); await setCap(g, x, 100n);
  await send('E1. before the end time the agent lane draws 5 to the venue', true, [await ownersDraw(g, x, vin, 5n)], own2);
  await send('E1b. recovery before the end time: 10 to R', true, [await ownersRec(g, x, 10n)], own2);
  await until(t + 1);
  await send('E2. after the end time the agent lane is refused (destination not allowed)', false, [await ownersDraw(g, x, vin, 5n)], own2, E.dest);
  await send('E2b. the Prime vault\'s own account is refused too', false, [await ownersDraw(g, x, v1U, 1n)], own2, E.dest);
  await send('E3. after the end time recovery works: 20 to R, above the cap left (95)? no, within', true, [await ownersRec(g, x, 20n)], own2);
  await send('E3b. recovery above the cap: 500 to R after the end time', true, [await ownersRec(g, x, 500n)], own2);
  await send('E4. one signer still lowers the cap after the end time', true, [allowIx(g, x, 10n * U, pks(lowerBy))], lowerBy);
  await send('E4b. the threshold raises it after the end time (the agent stays refused)', true, [allowIx(g, x, 50n * U, custodyBoth.map((k) => k.publicKey))], custodyBoth);
  await send('E4c. the agent lane is still refused', false, [await ownersDraw(g, x, vin, 1n)], own2, E.dest);
  { const g0 = await mkGate(MS.key, P, DESTS, { until: 0 }), x0 = await mkOwned(g0, MU, 100n); await setCap(g0, x0, 100n);
    await send('E5. a gate created with an end time of 0 (already ended): the agent lane never works', false, [await ownersDraw(g0, x0, vin, 1n)], own2, E.dest);
    await send('E5b. recovery works on it', true, [await ownersRec(g0, x0, 100n)], own2); }
});

await section('R', 'release: the multisig threshold hands the account back', async () => {
  const g = await mkGate(MS.key, P, DESTS);
  const x = await mkOwned(g, MU, 1000n); await setCap(g, x, 100n);
  const rel = (signers: Keypair[], o: { to?: PublicKey; ms?: PublicKey; src?: PublicKey } = {}) => releaseIx(g, o.src ?? x, o.to ?? newKey.publicKey, signers.map((k) => k.publicKey), { ms: o.ms });
  await send('R1. custody alone: refused (one slot of two)', false, [rel([custody])], [custody], E.lane);
  await send('R2. the trustee alone: refused', false, [rel([trustee])], [trustee], E.lane);
  await send('R3. a stranger: refused', false, [rel([stranger])], [stranger], E.lane);
  await send('R4. custody and a stranger: refused', false, [rel([custody, stranger])], [custody, stranger], E.lane);
  await send('R4b. custody listed twice counts once: refused', false, [rel([custody, custody])], [custody], E.lane);
  { const MX = await mkMs('', [stranger.publicKey, other.publicKey], 2);
    await send('R5. signers of another multisig name their own: refused, it is not the gate\'s', false, [rel([stranger, other], { ms: MX.key })], [stranger, other], E.lane); }
  await send('R5b. the owners of the Prime Account cannot release (the agent lane vault signs; it is no multisig signer)', false, [viaOwners(P, own2, AL, [vaultSigns(releaseIx(g, x, newKey.publicKey, [P.vault(AL)]))])], own2, E.lane);
  await send('R5c. the agent lane and the owners lane vaults cannot release either', false, [viaOwners(P, own2, OL, [vaultSigns(releaseIx(g, x, newKey.publicKey, [P.vault(OL)]))])], own2, E.lane);
  await send('R6. a hostile program as the token program: refused', false, [releaseIx(g, x, newKey.publicKey, custodyBoth.map((k) => k.publicKey), { tok: HOSTILE })], custodyBoth, E.wrong);
  await send('R6b. release data of the wrong length: refused by the gate', false, [new TransactionInstruction({ programId: GATE, data: Buffer.from([3, 1, 2, 3]), keys: [m(g.addr), m(x, false, true), m(TOKEN_PROGRAM_ID), m(MS.key), m(custody.publicKey, true), m(trustee.publicKey, true)] })], custodyBoth, E.gateInvalid);
  const b0 = await bal(x);
  await send('R7. the threshold (custody and the trustee) releases the account to newKey', true, [rel(custodyBoth)], custodyBoth, undefined, { cost: 'release (2 signers)' });
  { const a = await acct(x);
    check('R7b. owner = newKey, close authority = newKey, delegate and cap cleared, balance intact', a.owner.equals(newKey.publicKey) && a.closeAuthority?.equals(newKey.publicKey) === true && a.delegate === null && a.delegatedAmount === 0n && a.amount === b0, await info(x)); }
  await send('R8. newKey alone moves 50 out: full control is back', true, [acts(x, newKey.publicKey, []).transfer(cU, 50n)], [newKey]);
  await send('R9. the gate can no longer draw: the agent lane is refused by the gate (the source is no longer its own)', false, [await ownersDraw(g, x, vin, 1n)], own2, E.wrong);
  await send('R9b. recovery is refused too (the gate is no longer the owner)', false, [await ownersRec(g, x, 1n)], own2, OWNER_MISMATCH);
  await send('R9c. custody and the trustee as a multisig owner: refused (they are not the owner)', false, [acts(x, MS.key, custodyBoth).transfer(cU, 1n)], custodyBoth, OWNER_MISMATCH);
  await send('R9d. a second release of the same account: refused by the token program', false, [rel(custodyBoth)], custodyBoth, OWNER_MISMATCH);
  // reversal: the setup can be rebuilt after a release
  await send('R10. newKey hands the account back to the gate (close authority first, then owner)', true, handOver(g, x, newKey.publicKey), [newKey]);
  check('R10b. read-back is clean', sc.checkHandedOver((await conn.getAccountInfo(x))!.data, g.addr).length === 0, await info(x));
  await send('R10c. the threshold sets a cap again and the agent lane draws 5', true, [allowIx(g, x, 30n * U, custodyBoth.map((k) => k.publicKey))], custodyBoth);
  await send('R10d. agent draw', true, [await ownersDraw(g, x, vin, 5n)], own2);
  { // release to a multisig: custody alone stays restricted
    const y = await mkOwned(g, MU, 10n), M2 = await mkMs('', [custody.publicKey, trustee.publicKey], 2);
    await send('R11. release to a multisig address (owner and close authority)', true, [rel(custodyBoth, { to: M2.key, src: y })], custodyBoth);
    await send('R11b. custody alone is refused on the released account (the multisig is its owner)', false, [acts(y, M2.key, [custody]).transfer(cU, 1n)], [custody], MISSING);
    await send('R11c. the multisig\'s threshold moves it', true, [acts(y, M2.key, custodyBoth).transfer(cU, 1n)], custodyBoth); }
  { // the weighted multisig [custody, backup, trustee, trustee], m = 3: custody's key is lost, the trustee and the backup release
    const MW = await mkMs('', sc.weightedSlots([custody.publicKey, backup.publicKey], trustee.publicKey, 3), 3);
    const gw = await mkGate(MW.key, P, DESTS), y = await mkOwned(gw, MU, 10n);
    const relw = (by: Keypair[]) => releaseIx(gw, y, newKey.publicKey, by.map((k) => k.publicKey));
    await send('R12. weighted multisig: custody and the backup (weight 2 of 3) cannot release', false, [relw([custody, backup])], [custody, backup], E.lane);
    await send('R12b. the trustee alone (weight 2) cannot release', false, [relw([trustee])], [trustee], E.lane);
    await send('R12c. custody\'s key is lost: the trustee and the backup (weight 3) release', true, [relw([trustee, backup])], [trustee, backup]);
    check('R12d. owner = newKey', (await acct(y)).owner.equals(newKey.publicKey), await info(y));
    const y2 = await mkOwned(gw, MU, 20n);
    await send('R12e. with custody\'s key lost the trustee and the backup (weight 3) raise the cap on another account', true, [allowIx(gw, y2, 15n * U, [trustee.publicKey, backup.publicKey])], [trustee, backup]);
    await send('R12f. the agent lane draws under that cap (no custody signature anywhere)', true, [await ownersDraw(gw, y2, vin, 5n)], own2);
    await send('R12g. and the owners recover the rest to R (no custody signature anywhere)', true, [await ownersRec(gw, y2, 15n)], own2); }
  { const y = await mkOwned(g, MU, 10n), own = await mkAcct(MU, custody.publicKey, { amount: 5n });
    await send('R13. an account the gate does not own (custody\'s plain account): refused by the token program', false, [rel(custodyBoth, { src: own })], custodyBoth, OWNER_MISMATCH);
    const t = await later(3), ge = await mkGate(MS.key, P, DESTS, { until: t }), ye = await mkOwned(ge, MU, 10n); await until(t + 1);
    await send('R14. release works after the end time too', true, [releaseIx(ge, ye, newKey.publicKey, custodyBoth.map((k) => k.publicKey))], custodyBoth); void y; }
});

await section('P', 'the agent\'s rule: draw and payback in one atomic batch', async () => {
  const g = await mkGate(MS.key, P, [venuePda]), x = await mkOwned(g, MU, 1000n); await setCap(g, x, 200n);
  const PS = await installRule('P1. owners install rule PS (agent alone) at lane 1: gate draw of 1 to 100 from x into the venue account, and the venue payback to x of at most 100', P, [transferC(g, x, vin, 1n, 100n), paybackC(vin, x, 100n)], [agentKey(agent)], 1);
  costs['rule PS (gate draw + venue payback)'] = { bytes: PS.bytes, rent: PS.rent };
  const run = (name: string, ok: boolean, instrs: TransactionInstruction[], idx: number[], want?: RegExp, cost?: string) => send(name, ok, [viaPolicy(P, PS.policy, [agent], instrs, idx)], [agent], want, { cost });
  const snap = async () => `${await bal(x)}/${(await acct(x)).delegatedAmount}/${await bal(vin)}`;
  await run('P2. the agent draws 40 to the venue through the rule', true, [await draw(g, x, vin, 40n)], [0], undefined, 'agent draw through a rule (sync)');
  { const s0 = await snap();
    await run('P3. one atomic batch: draw 20 into the venue, the venue pays 20 back into x', true, [await draw(g, x, vin, 20n), paybackIx(vin, x, 20n * U)], [0, 1], undefined, 'agent batch: draw + venue payback (sync)');
    check('P3b. x is unchanged, the cap fell by 20', (await bal(x)) === BigInt(s0.split('/')[0]) && (await acct(x)).delegatedAmount === BigInt(s0.split('/')[1]) - 20n * U, await snap()); }
  await run('P4. 101 (over the rule\'s band): refused by the rule', false, [await draw(g, x, vin, 101n)], [0], E.num);
  await run('P5. the agent names a stranger\'s account (the rule pins the venue account): refused by the rule', false, [await draw(g, x, sU, 5n)], [0], E.acct);
  await run('P6. the agent names the recovery account: refused by the rule', false, [await draw(g, x, rU, 5n)], [0], E.acct);
  { const s0 = await snap();
    await run('P7. a batch whose payback fails (wrong token program): the whole batch is rolled back, the draw too', false, [await draw(g, x, vin, 10n), paybackIx(vin, x, 5n * U, TOKEN_2022_PROGRAM_ID)], [0, 1]);
    check('P7b. nothing moved and the cap is untouched', (await snap()) === s0, await snap()); }
  await send('P8. the agent asks Squads to sign as the owners lane (vault 3) under its own rule: refused by Squads', false, [viaPolicy(P, PS.policy, [agent], [await rec(g, x, 5n)], [0], OL)], [agent], /InvalidPayload|AccountIndex|ProgramInteraction|Constraint|Invalid/i);
  await run('P9. the agent calls allow (raise the cap) under the rule: refused by the rule (it admits the draw only)', false, [vaultSigns(allowIx(g, x, 500n * U, [P.vault(AL)]))], [0], /ProgramInteraction/);
  await run('P9b. the agent calls release under the rule: refused by the rule', false, [vaultSigns(releaseIx(g, x, agent.publicKey, [P.vault(AL)]))], [0], /ProgramInteraction/);
  { // a session-style rule at vault 0 reaches nothing: the gate's lanes are never vault 0
    const S0 = await installRule('P10. owners install a rule at lane 0 (where session rules sign) for the agent: the same draw', P, [transferC(g, x, vin, 1n, 100n)], [agentKey(agent)], 1, { lane: 0 });
    await send('P10b. the agent draws as vault 0: refused by the gate (not a lane)', false, [viaPolicy(P, S0.policy, [agent], [await draw(g, x, vin, 5n, { lane: P.vault(0) })], [0], 0)], [agent], E.lane); }
});

await section('TL', 'the whole batch waits in the owners\' rule (Squads time lock) and runs as one transaction', async () => {
  const WW = 5, g = await mkGate(MS.key, P, [venuePda], { window: 60 }), x = await mkOwned(g, MU, 1000n); await setCap(g, x, 100n);
  const PW = await installRule(`TL1. owners install rule PW at lane 1 with a ${WW} s time lock: the agent stores [draw from x to the venue, venue pays x]; vault 3 (the owners lane) holds a vote-only seat to cancel`, P,
    [transferC(g, x, vin, 1n, 50n), paybackC(vin, x, 50n)], [agentKey(agent), voteOnly(P.vault(OL))], 1, { timeLock: WW });
  costs['rule PW (time lock, 2 constraints)'] = { bytes: PW.bytes, rent: PW.rent };
  await send('TL2. the synchronous path of a rule with a time lock is refused', false, [viaPolicy(P, PW.policy, [agent], [await draw(g, x, vin, 5n)], [0])], [agent], /TimeLockNotZero/);
  const batch = async (n: bigint, by: number, idx = [0, 1]) => store(PW.policy, agent, P.vault(AL), [await draw(g, x, vin, n, { notAfter: by }), paybackIx(vin, x, n * U)], idx);
  const put = async (b: Awaited<ReturnType<typeof batch>>, name = '', cost?: string) => send(name, true, b.ixs, [agent], undefined, { quiet: !name, units: 600_000, cost });
  let b = await batch(20n, await later(WW + 40));
  await put(b, 'TL3. the agent stores the whole batch (create, propose, approve)', 'agent stores a batch (time lock)');
  { const tx = await conn.getAccountInfo(sa.getTransactionPda({ settingsPda: PW.policy, transactionIndex: b.index, programId: lib.SQUADS })[0]), pr = await conn.getAccountInfo(sa.getProposalPda({ settingsPda: PW.policy, transactionIndex: b.index })[0]);
    costs['stored batch rent'] = { transactionBytes: tx?.data.length, transactionRent: tx?.lamports, proposalBytes: pr?.data.length, proposalRent: pr?.lamports }; }
  await send('TL4. run before the wait: refused', false, [runStored(PW.policy, b.index, agent.publicKey, b.metas)], [agent], /TimeLockNotReleased/, { units: 600_000 });
  await until((await propTime(PW.policy, b.index)) + WW);
  { const c0 = (await acct(x)).delegatedAmount, x0 = await bal(x);
    await send('TL5. after the wait the whole batch runs as one transaction (draw and payback)', true, [runStored(PW.policy, b.index, agent.publicKey, b.metas)], [agent], undefined, { units: 600_000, cost: 'run a stored batch (draw + payback)' });
    check('TL5b. both legs ran: x unchanged, the cap fell by 20', (await bal(x)) === x0 && (await acct(x)).delegatedAmount === c0 - 20n * U, await info(x)); }
  await send('TL5c. the same batch cannot run twice', false, [runStored(PW.policy, b.index, agent.publicKey, b.metas)], [agent], /InvalidProposalStatus/, { units: 600_000 });
  // cancel by the owners through the vote-only seat
  b = await batch(10n, await later(WW + 40)); await put(b);
  await send('TL6. one owner alone signing as vault 3 cannot cancel', false, [viaOwners(P, [owners[1]], OL, [ix.cancelProposal({ settingsPda: PW.policy, transactionIndex: b.index, signer: P.vault(OL) })])], [owners[1]], E.signers);
  await send('TL6b. custody (a multisig signer, no seat on the rule) cannot cancel', false, [ix.cancelProposal({ settingsPda: PW.policy, transactionIndex: b.index, signer: custody.publicKey })], [custody], E.notSigner);
  await send('TL6c. the owners (2 of 3, signing as vault 3) cancel the stored batch', true, [viaOwners(P, own2b, OL, [ix.cancelProposal({ settingsPda: PW.policy, transactionIndex: b.index, signer: P.vault(OL) })])], own2b, undefined, { cost: 'owners cancel a stored batch (sync)' });
  await until((await propTime(PW.policy, b.index)) + WW);
  await send('TL6d. the cancelled batch cannot run', false, [runStored(PW.policy, b.index, agent.publicKey, b.metas)], [agent], /InvalidProposalStatus/, { units: 600_000 });
  // custody's one-signature stop: lowering the cap while the batch waits
  b = await batch(10n, await later(WW + 50)); await put(b);
  await send('TL7. custody alone lowers the cap to 1 while the batch waits', true, [allowIx(g, x, 1n * U, pks(lowerBy))], lowerBy);
  await until((await propTime(PW.policy, b.index)) + WW);
  { const s0 = `${await bal(x)}/${await bal(vin)}`;
    await send('TL7b. the run is refused by the token program (over the cap); the venue leg does not run either', false, [runStored(PW.policy, b.index, agent.publicKey, b.metas)], [agent], E.funds, { units: 600_000 });
    check('TL7c. nothing moved and the stored batch is still Approved (Squads has no run window)', s0 === `${await bal(x)}/${await bal(vin)}` && (await statusOf(PW.policy, b.index)).__kind === 'Approved'); }
  await send('TL7d. the threshold raises the cap again', true, [allowIx(g, x, 100n * U, custodyBoth.map((k) => k.publicKey))], custodyBoth);
  await send('TL7e. the same stored batch now runs', true, [runStored(PW.policy, b.index, agent.publicKey, b.metas)], [agent], undefined, { units: 600_000 });
  // lapse: the batch's not-after passes while the cap is suspended, then the cap returns
  b = await batch(10n, (await chainNow()) + WW + 7); await put(b);
  await send('TL8. the trustee suspends the cap while the batch waits', true, [allowIx(g, x, 0n, pks(lowerBy2))], lowerBy2);
  await until((await chainNow()) + WW + 9);
  await send('TL8b. the threshold resumes the cap after the batch\'s not-after', true, [allowIx(g, x, 100n * U, custodyBoth.map((k) => k.publicKey))], custodyBoth);
  await send('TL8c. the old batch has lapsed: refused by the gate (past its not-after)', false, [runStored(PW.policy, b.index, agent.publicKey, b.metas)], [agent], E.window, { units: 600_000 });
  // a not-after far beyond the window is refused until the window opens
  b = await batch(10n, (await chainNow()) + 3600); await put(b);
  await until((await propTime(PW.policy, b.index)) + WW);
  await send('TL9. a batch with a not-after an hour out cannot run after its wait (outside custody\'s 60 s window)', false, [runStored(PW.policy, b.index, agent.publicKey, b.metas)], [agent], E.window, { units: 600_000 });
  // the gate's end time while a batch waits
  { const t = await later(WW + 12), ge = await mkGate(MS.key, P, [venuePda], { until: t }), xe = await mkOwned(ge, MU, 100n); await setCap(ge, xe, 100n);
    const PE = await installRule('TL10. rule PE (same shape, 3 s time lock) on a gate that ends soon', P, [transferC(ge, xe, vin, 1n, 50n)], [agentKey(agent)], 1, { timeLock: 3 });
    const be = await store(PE.policy, agent, P.vault(AL), [await draw(ge, xe, vin, 5n, { notAfter: t + 30 })], [0]); await send('', true, be.ixs, [agent], undefined, { quiet: true, units: 600_000 });
    await until(t + 1);
    await send('TL10b. the gate has ended: the stored batch is refused by the gate (destination not allowed)', false, [runStored(PE.policy, be.index, agent.publicKey, be.metas)], [agent], E.dest, { units: 600_000 }); }
  // the rule's own expiry
  { const PX = await installRule('TL11. rule PX (3 s time lock) that expires in 14 s', P, [transferC(g, x, vin, 1n, 50n)], [agentKey(agent)], 1, { timeLock: 3, expiresAt: await later(14) });
    const bx = await store(PX.policy, agent, P.vault(AL), [await draw(g, x, vin, 5n, { notAfter: await later(60) })], [0]); await send('', true, bx.ixs, [agent], undefined, { quiet: true, units: 600_000 });
    await until((await chainNow()) + 16);
    await send('TL11b. after the rule expires its stored batch cannot run', false, [runStored(PX.policy, bx.index, agent.publicKey, bx.metas)], [agent], /PolicyExpiration/, { units: 600_000 }); }
});

await section('RR', 'recovery through the owners\' rule with a time lock; the cap does not bind it', async () => {
  const RW = 5, g = await mkGate(MS.key, P, DESTS), x = await mkOwned(g, MU, 1000n); await setCap(g, x, 100n);
  const PR = await installRule(`RR1. owners install recovery rule PR at lane 3: the three owners are its signers, threshold 2, time lock ${RW} s, pays R only`, P,
    [{ programId: g.gp, accountConstraints: [pin(0, g.addr), pin(2, x), pin(3, rU)], dataConstraints: [dc('U8', 0, 1, D.Equals)] }], owners.map((k) => agentKey(k)), 2, { timeLock: RW, lane: OL });
  const recStore = async (n: bigint) => { const s = await store(PR.policy, owners[0], P.vault(OL), [await rec(g, x, n, { notAfter: await later(RW + 60) })], [0], OL);
    await send('', true, s.ixs, [owners[0]], undefined, { quiet: true, units: 600_000 });
    await send('', true, [ix.approveProposal({ settingsPda: PR.policy, transactionIndex: s.index, signer: owners[1].publicKey })], [owners[1]], undefined, { quiet: true }); return s; };
  await send('RR2. the agent\'s key cannot store a recovery under this rule (it is no signer of the rule)', false, [(await store(PR.policy, agent, P.vault(OL), [await rec(g, x, 5n)], [0], OL)).ixs[0]], [agent], E.notSigner);
  let s1 = await recStore(300n);
  await send('RR3. run before the wait', false, [runStored(PR.policy, s1.index, owners[0].publicKey, s1.metas)], [owners[0]], /TimeLockNotReleased/, { units: 600_000 });
  await send('RR3b. custody suspends the cap during the wait (a recovery is not stopped by it)', true, [allowIx(g, x, 0n, pks(lowerBy))], lowerBy);
  await until((await propTime(PR.policy, s1.index)) + RW);
  { const r0 = await bal(rU);
    await send('RR4. after the wait the stored recovery runs: 300 to R although the cap is 0 and the balance exceeds the old cap', true, [runStored(PR.policy, s1.index, owners[0].publicKey, s1.metas)], [owners[0]], undefined, { units: 600_000, cost: 'run a stored recovery' });
    check('RR4b. R gained 300', (await bal(rU)) - r0 === 300n * U); }
  const s2 = await recStore(10n);
  await send('RR5. one owner votes to cancel', true, [ix.cancelProposal({ settingsPda: PR.policy, transactionIndex: s2.index, signer: owners[2].publicKey })], [owners[2]]);
  check('RR5b. one cancel vote is below the threshold: still Approved', (await statusOf(PR.policy, s2.index)).__kind === 'Approved');
  await send('RR5c. a second owner votes to cancel', true, [ix.cancelProposal({ settingsPda: PR.policy, transactionIndex: s2.index, signer: owners[0].publicKey })], [owners[0]]);
  check('RR5d. Cancelled', (await statusOf(PR.policy, s2.index)).__kind === 'Cancelled');
  await until((await chainNow()) + RW + 1);
  await send('RR5e. the cancelled recovery cannot run', false, [runStored(PR.policy, s2.index, owners[0].publicKey, s2.metas)], [owners[0]], /InvalidProposalStatus/, { units: 600_000 });
  await send('RR6. custody (no signer of the rule) cannot cancel a stored recovery', false, [ix.cancelProposal({ settingsPda: PR.policy, transactionIndex: s2.index, signer: custody.publicKey })], [custody], E.notSigner);
  await send('RR7. the rule\'s wait binds only those who use it: the owners (2 of 3) pay R at once through the settings path', true, [await ownersRec(g, x, 5n)], own2);
  { // a Prime Account with its own time lock closes the synchronous path: then the recovery wait is real
    const PT = await new Prime(owners, 2).create(), gt = await mkGate(MS.key, PT, DESTS), xt = await mkOwned(gt, MU, 100n);
    const rule = await installRule('RR8. a second Prime Account PT: the owners install the same recovery rule (time lock 5 s)', PT, [{ programId: gt.gp, accountConstraints: [pin(0, gt.addr), pin(2, xt), pin(3, rU)], dataConstraints: [dc('U8', 0, 1, D.Equals)] }], owners.map((k) => agentKey(k)), 2, { timeLock: RW, lane: OL });
    const sync0 = await send('RR8b. before PT has a time lock the owners pay R at once through the settings path', true, [viaOwners(PT, own2, OL, [transferIx({ gate: gt, lane: PT.vault(OL), src: xt, dst: rU, amount: 1n * U, notAfter: await later() })])], own2);
    await PT.decide('RR8c', owners[0], owners[1], [{ __kind: 'SetTimeLock', newTimeLock: 5 }]);
    check('RR8d. the Prime Account\'s own time lock is now 5 s', (await sa.accounts.Settings.fromAccountAddress(conn, PT.settings)).timeLock === 5);
    await send('RR8e. now the owners\' synchronous path is refused: the wait cannot be skipped', false, [viaOwners(PT, own2, OL, [transferIx({ gate: gt, lane: PT.vault(OL), src: xt, dst: rU, amount: 1n * U, notAfter: await later() })])], own2, /TimeLockNotZero/);
    const st2 = await store(rule.policy, owners[0], PT.vault(OL), [transferIx({ gate: gt, lane: PT.vault(OL), src: xt, dst: rU, amount: 7n * U, notAfter: await later(RW + 60) })], [0], OL);
    await send('', true, st2.ixs, [owners[0]], undefined, { quiet: true, units: 600_000 }); await send('', true, [ix.approveProposal({ settingsPda: rule.policy, transactionIndex: st2.index, signer: owners[1].publicKey })], [owners[1]], undefined, { quiet: true });
    await send('RR8f. the stored recovery cannot run before the rule\'s wait', false, [runStored(rule.policy, st2.index, owners[0].publicKey, st2.metas)], [owners[0]], /TimeLockNotReleased/, { units: 600_000 });
    await until((await propTime(rule.policy, st2.index)) + RW);
    await send('RR8g. after the wait it runs', true, [runStored(rule.policy, st2.index, owners[0].publicKey, st2.metas)], [owners[0]], undefined, { units: 600_000 }); void sync0; }
});

await section('Z', 'Token-2022', async () => {
  const T22 = TOKEN_2022_PROGRAM_ID, g = await mkGate(MS.key, P, DESTS);
  const v22 = ata(MU22, venuePda, T22), r22 = ata(MU22, recovery.publicKey, T22), s22 = ata(MU22, stranger.publicKey, T22);
  await must('atas', [mkAta(MU22, venuePda, T22), mkAta(MU22, recovery.publicKey, T22), mkAta(MU22, stranger.publicKey, T22), mkAta(MU22, custody.publicKey, T22)], []);
  const x = await mkOwned(g, MU22, 1000n, { prog: T22 });
  { const d = (await conn.getAccountInfo(x))!.data;
    check('Z1. a dedicated Token-2022 account is 165 bytes; owner and close authority are the gate; setup-checks reads it back clean', d.length === 165 && sc.checkHandedOver(d, g.addr).length === 0 && sc.checkSourceAccount(x, d, T22).length === 0, await info(x, T22)); }
  { const w = await mkAcct(MU22, custody.publicKey, { prog: T22 });
    await send('Z1c. Token-2022, owner first: the account goes to the gate', true, [handOver(g, w, custody.publicKey, T22)[1]], [custody]);
    await send('Z1d. then the close authority: refused (the signer must now be the gate); it stays unset and falls back to the owner, as on Token', false, [handOver(g, w, custody.publicKey, T22)[0]], [custody], /token2022: custom program error: 0x4\b/);
    check('Z1e. owner = gate, close authority unset', (await acct(w, T22)).owner.equals(g.addr) && (await acct(w, T22)).closeAuthority === null, await info(w, T22)); }
  await send('Z1b. custody alone is refused on it', false, [acts(x, custody.publicKey, [], T22).transfer(ata(MU22, custody.publicKey, T22), 1n)], [custody], /token2022: custom program error: 0x4\b/);
  await send('Z2. the threshold sets a cap of 100 (Token-2022 Approve through the gate)', true, [allowIx(g, x, 100n * U, custodyBoth.map((k) => k.publicKey), { tok: T22 })], custodyBoth);
  const t22 = { tok: T22 };
  await send('Z3. the agent lane draws 10 to the venue (Token-2022)', true, [await ownersDraw(g, x, v22, 10n, t22)], own2, undefined, { cost: 'agent lane draw, owners as the lane (Token-2022)' });
  await send('Z3b. over the cap: refused by Token-2022', false, [await ownersDraw(g, x, v22, 95n, t22)], own2, /token2022: custom program error: 0x1\b/);
  await send('Z3c. the Token program id named for a Token-2022 account: refused by the token program', false, [await ownersDraw(g, x, v22, 1n)], own2, /token: |incorrect program id|invalid account owner/i);
  await send('Z4. the owners lane recovers 300 (above the cap) to R (Token-2022)', true, [await ownersRec(g, x, 300n, { ...t22, dst: r22 })], own2);
  await send('Z4b. a stranger\'s Token-2022 account is refused by the gate', false, [await ownersDraw(g, x, s22, 1n, t22)], own2, E.dest);
  await send('Z5. one signer lowers the cap to 0 on the Token-2022 account', true, [allowIx(g, x, 0n, pks(lowerBy), { tok: T22 })], lowerBy);
  await send('Z6. the threshold releases it to newKey', true, [releaseIx(g, x, newKey.publicKey, custodyBoth.map((k) => k.publicKey), { tok: T22 })], custodyBoth);
  check('Z6b. owner and close authority are newKey', (await acct(x, T22)).owner.equals(newKey.publicKey) && (await acct(x, T22)).closeAuthority?.equals(newKey.publicKey) === true, await info(x, T22));
  { // associated accounts
    const a22 = ata(MU22, custody.publicKey, T22);
    const d = (await conn.getAccountInfo(a22))!.data;
    check('Z7. custody\'s Token-2022 associated account carries the immutable-owner extension: setup-checks flags it as associated and as extended', sc.checkSourceAccount(a22, d, T22).map((i) => i.code).join() === 'associated-account,extensions', `${d.length} B`);
    await send('Z7b. SetAuthority(AccountOwner) on it is refused by Token-2022 (immutable owner, error 0x22): such funds go into a dedicated account by transfer', false, [acts(a22, custody.publicKey, [], T22).setOwner(g.addr)], [custody], /token2022: custom program error: 0x22\b/);
    const cA = ata(MU, custody.publicKey), dA = (await conn.getAccountInfo(cA))!.data;
    { const cA2 = ata(MT, custody.publicKey);
      await must('ata', [mkAta(MT, custody.publicKey)], []);
      await send('Z7d. a classic associated account CAN be handed over by SetAuthority (the token program allows it)', true, handOver(g, cA2, custody.publicKey), [custody]);
      await send('Z7e. but its address still names custody: the associated token program then refuses to create custody\'s own account for that mint (the idempotent create fails)', false, [mkAta(MT, custody.publicKey)], [], /associated|custom program error|incorrect|owner/i);
      check('Z7f. setup-checks flags the account as associated before the hand-over, so the app moves funds into a dedicated account instead', true); }
    check('Z7c. a classic associated account is flagged as associated too (its address names custody)', sc.checkSourceAccount(cA, dA, TOKEN_PROGRAM_ID).map((i) => i.code).join() === 'associated-account'); }
  { // fee and hook mints: refused by the token program, the gate fails closed
    for (const kind of ['fee', 'hook'] as const) {
      const mint = lib.gen(), len = getMintLen([kind === 'fee' ? ExtensionType.TransferFeeConfig : ExtensionType.TransferHook]);
      const init = kind === 'fee' ? createInitializeTransferFeeConfigInstruction(mint.publicKey, payer.publicKey, payer.publicKey, 100, 1_000_000_000n, T22) : createInitializeTransferHookInstruction(mint.publicKey, payer.publicKey, VENUE, T22);
      await must('mint', [SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: len, lamports: await conn.getMinimumBalanceForRentExemption(len), programId: T22 }), init,
        createInitializeMintInstruction(mint.publicKey, 6, payer.publicKey, null, T22)], [mint]);
      const ka = lib.gen(), space = getAccountLen([kind === 'fee' ? ExtensionType.TransferFeeAmount : ExtensionType.TransferHookAccount]), vk = ata(mint.publicKey, venuePda, T22);
      await must('acct', [SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: ka.publicKey, space, lamports: await conn.getMinimumBalanceForRentExemption(space), programId: T22 }),
        createInitializeAccount3Instruction(ka.publicKey, mint.publicKey, custody.publicKey, T22), createMintToInstruction(mint.publicKey, ka.publicKey, payer.publicKey, 1000n * U, [], T22), mkAta(mint.publicKey, venuePda, T22), ...handOver(g, ka.publicKey, custody.publicKey, T22)], [ka, custody]);
      await must('cap', [allowIx(g, ka.publicKey, 500n * U, custodyBoth.map((k) => k.publicKey), { tok: T22 })], custodyBoth);
      const d = (await conn.getAccountInfo(ka.publicKey))!.data;
      check(`Z8${kind === 'fee' ? 'a' : 'b'}. setup-checks flags the ${kind} mint's account (${d.length} bytes, extensions)`, sc.checkSourceAccount(ka.publicKey, d, T22).map((i) => i.code).join() === 'extensions');
      const c0 = await bal(ka.publicKey, T22);
      await send(`Z8${kind === 'fee' ? 'c' : 'd'}. the agent lane draws 10 of a ${kind === 'fee' ? 'transfer-fee' : 'transfer-hook'} mint: refused by Token-2022 (plain Transfer), nothing moves`, false, [await ownersDraw(g, ka.publicKey, vk, 10n, { tok: T22 })], own2, E.t22mint);
      check(`Z8${kind === 'fee' ? 'e' : 'f'}. balance and cap unchanged`, (await bal(ka.publicKey, T22)) === c0 && (await acct(ka.publicKey, T22)).delegatedAmount === 500n * U);
    } }
  { // the CPI guard: switched on before the hand-over, it blocks the owner change itself
    const kc = lib.gen(), space = getAccountLen([ExtensionType.CpiGuard]);
    await must('cg', [SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: kc.publicKey, space: 165, lamports: await conn.getMinimumBalanceForRentExemption(space), programId: T22 }),
      createInitializeAccount3Instruction(kc.publicKey, MU22, custody.publicKey, T22), createMintToInstruction(MU22, kc.publicKey, payer.publicKey, 50n * U, [], T22),
      createReallocateInstruction(kc.publicKey, payer.publicKey, [ExtensionType.CpiGuard], custody.publicKey, [], T22), createEnableCpiGuardInstruction(kc.publicKey, custody.publicKey, [], T22)], [kc, custody]);
    const d = (await conn.getAccountInfo(kc.publicKey))!.data;
    check('Z9. an account with the CPI guard switched on: setup-checks flags the extension before the hand-over', sc.checkSourceAccount(kc.publicKey, d, T22).map((i) => i.code).join() === 'extensions', `${d.length} B`);
    await send('Z9b. the hand-over of its close authority works, but the owner change is refused by Token-2022 while the guard is on (error 0x2f): such an account never reaches the gate', false, [handOver(g, kc.publicKey, custody.publicKey, T22)[1]], [custody], /token2022: custom program error: 0x2f\b/); }
});

await section('N', 'wrapped SOL', async () => {
  const g = await mkGate(MS.key, P, DESTS);
  const vW = ata(NATIVE_MINT, P.vault(AL)), rW = ata(NATIVE_MINT, recovery.publicKey);     // the native mint is shared by every run: use accounts of this run's own Prime vault and recovery key
  await must('atas', [mkAta(NATIVE_MINT, P.vault(AL)), mkAta(NATIVE_MINT, recovery.publicKey)], []);
  const kw = await mkAcctKp(NATIVE_MINT, custody.publicKey, { closeAuth: custody.publicKey, signer: custody }), w = kw.publicKey;
  await must('fund', [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: w, lamports: 2 * SOL }), createSyncNativeInstruction(w)], []);
  check('N0. custody opens a wrapped-SOL account with 2 SOL and a close authority of its own', (await bal(w)) === BigInt(2 * SOL) && (await acct(w)).closeAuthority?.equals(custody.publicKey) === true, await info(w));
  await send('N1. custody hands it to the gate: close authority first, then owner', true, handOver(g, w, custody.publicKey), [custody]);
  { const a = await acct(w);
    check('N2. owner = gate; the close authority is cleared by the token program on the owner change of a native account (none, the owner is the closer); setup-checks accepts the read-back', a.owner.equals(g.addr) && a.closeAuthority === null && a.isNative && sc.checkHandedOver((await conn.getAccountInfo(w))!.data, g.addr).length === 0, await info(w)); }
  { const kw2 = await mkAcctKp(NATIVE_MINT, custody.publicKey, { closeAuth: custody.publicKey, signer: custody });
    await must('fund', [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: kw2.publicKey, lamports: SOL }), createSyncNativeInstruction(kw2.publicKey)], []);
    await send('N1b. wrapped SOL, owner first: the owner change clears the native account\'s close authority; the gate is the owner and so the closer', true, [handOver(g, kw2.publicKey, custody.publicKey)[1]], [custody]);
    check('N1c. owner = gate, close authority unset, setup-checks accepts the read-back', (await acct(kw2.publicKey)).owner.equals(g.addr) && (await acct(kw2.publicKey)).closeAuthority === null && sc.checkHandedOver((await conn.getAccountInfo(kw2.publicKey))!.data, g.addr).length === 0, await info(kw2.publicKey)); }
  await send('N3. custody alone: close (sweep the lamports to itself)', false, [createCloseAccountInstruction(w, custody.publicKey, custody.publicKey)], [custody], OWNER_MISMATCH);
  await send('N3b. custody alone: transfer wrapped SOL', false, [acts(w, custody.publicKey, []).transfer(vW, 1n)], [custody], OWNER_MISMATCH);
  await send('N4. the threshold sets a cap of 0.6 wrapped SOL', true, [allowIx(g, w, 600_000_000n, custodyBoth.map((k) => k.publicKey))], custodyBoth);
  { const l0 = await conn.getBalance(vW);
    await send('N5. the agent lane draws 0.4 wrapped SOL to the venue; the lamports follow', true, [await ownersDraw(g, w, vW, 0n, { amount: 400_000_000n })], own2, undefined, { cost: 'agent lane draw, owners as the lane (wrapped SOL)' });
    check('N5b. the venue account gained 0.4 SOL of lamports', (await conn.getBalance(vW)) - l0 === 400_000_000, `${(await conn.getBalance(vW)) - l0}`); }
  await send('N5c. 0.3 more (0.2 left of the cap): refused', false, [await ownersDraw(g, w, vW, 0n, { amount: 300_000_000n })], own2, E.funds);
  await send('N6. recovery of 1 SOL (above the cap) to R\'s wrapped-SOL account', true, [await ownersRec(g, w, 0n, { amount: 1_000_000_000n, dst: rW })], own2);
  check('N6b. R\'s wrapped-SOL account holds 1 SOL', (await bal(rW)) === BigInt(SOL));
  await send('N7. the threshold releases the account to newKey', true, [releaseIx(g, w, newKey.publicKey, custodyBoth.map((k) => k.publicKey))], custodyBoth);
  { const n0 = await conn.getBalance(newKey.publicKey);
    await send('N7b. newKey closes it and receives the remaining lamports (unwrap)', true, [createCloseAccountInstruction(w, newKey.publicKey, newKey.publicKey)], [newKey]);
    check('N7c. newKey gained about 0.6 SOL plus the account\'s rent', (await conn.getBalance(newKey.publicKey)) - n0 > 0.5 * SOL, `${((await conn.getBalance(newKey.publicKey)) - n0) / SOL} SOL`); }
});

await section('SC', 'setup-checks on the live validator', async () => {
  const slots = (m: PublicKey) => conn.getAccountInfo(m).then((a) => sc.parseMultisig(a!.data));
  const who = { custody: [custody.publicKey], trustee: trustee.publicKey };
  const sim = async (ms: PublicKey, signers: lib.Keypair[], acc: PublicKey, prog = TOKEN_PROGRAM_ID) => sc.simulateTestSignature(conn, { account: acc, ms, signers, feePayer: payer, program: prog });
  { const a = await mkAcct(MU, MS.key);
    check('SC1. parseMultisig reads the live 2-of-2: m 2, n 2, slots custody and trustee; checkMultisig is clean', await slots(MS.key).then((x) => x.m === 2 && x.n === 2 && x.slots[0].equals(custody.publicKey) && x.slots[1].equals(trustee.publicKey) && sc.checkMultisig(x, who).length === 0));
    const ok = await sim(MS.key, [custody, trustee], a), c1 = await sim(MS.key, [custody], a), t1 = await sim(MS.key, [trustee], a);
    record('SC2. the test signature (a zero-amount transfer, simulated) passes for custody and the trustee', true, ok.ok, ok.error);
    record('SC2b. custody alone fails the test signature', false, c1.ok, c1.error, /MissingRequiredSignature|missing required signature|0x3|Custom/i);
    record('SC2c. the trustee alone fails it', false, t1.ok, t1.error, /./);
    await send('SC2d. the same test signature as a real transaction moves nothing', true, [sc.testSignatureIx(a, MS.key, [custody.publicKey, trustee.publicKey])], custodyBoth); }
  { const M32 = await mkMs('', [custody.publicKey, trustee.publicKey], 3), a = await mkAcct(MU, M32.key), x = await slots(M32.key);
    check('SC3. m = 3, n = 2: checkMultisig flags m-greater-than-n before any funds move', sc.checkMultisig(x, who).map((i) => i.code).includes('m-greater-than-n'));
    const r = await sim(M32.key, [custody, trustee], a); record('SC3b. and the test signature fails even with both signers (nothing could ever move)', false, r.ok, r.error, /./); }
  { const M23 = await mkMs('', [custody.publicKey, backup.publicKey, trustee.publicKey], 2), a = await mkAcct(MU, M23.key), x = await slots(M23.key), w2 = { custody: [custody.publicKey, backup.publicKey], trustee: trustee.publicKey };
    check('SC4. 2-of-3 with two custody keys: checkMultisig flags custody-reaches-m', sc.checkMultisig(x, w2).map((i) => i.code).join() === 'custody-reaches-m');
    const r = await sim(M23.key, [custody, backup], a); record('SC4b. the test signature passes for custody and its backup alone: the trustee is not mandatory (this is what the check catches)', true, r.ok, r.error); }
  { const slotsW = sc.weightedSlots([custody.publicKey, backup.publicKey], trustee.publicKey, 3), MW = await mkMs('', slotsW, 3), a = await mkAcct(MU, MW.key), x = await slots(MW.key), w2 = { custody: [custody.publicKey, backup.publicKey], trustee: trustee.publicKey };
    check('SC5. weighted [custody, backup, trustee, trustee], m = 3: checkMultisig is clean and weight(trustee) = 2', sc.checkMultisig(x, w2).length === 0 && sc.weight(x, [trustee.publicKey]) === 2);
    for (const [id, name, by, want] of [['a', 'custody and the backup', [custody, backup], false], ['b', 'the trustee alone', [trustee], false], ['c', 'the trustee and custody', [trustee, custody], true], ['d', 'the trustee and the backup', [trustee, backup], true]] as [string, string, lib.Keypair[], boolean][]) {
      const r = await sim(MW.key, by, a); record(`SC5${id}. test signature by ${name}`, want, r.ok, r.error, /./); } }
  { // an account owned by the multisig carries its owner and close authority: handing a dedicated account to the multisig itself is the a3 restriction; not used by the gate
    const a = await mkAcct(MU, custody.publicKey), cd = (await conn.getAccountInfo(a))!.data;
    check('SC6. a dedicated account of custody passes checkSourceAccount (165 bytes, not associated) and fails checkHandedOver before the hand-over (owner is custody)', sc.checkSourceAccount(a, cd, TOKEN_PROGRAM_ID).length === 0 && sc.checkHandedOver(cd, PublicKey.default).map((i) => i.code).includes('owner-not-gate')); }
  { // 11 signers
    const k11 = Array.from({ length: 11 }, () => lib.gen()); for (const k of k11) await fund(k.publicKey, 0.05);
    const M11 = await mkMs('', k11.map((k) => k.publicKey), 11);
    const g = await mkGate(M11.key, P, DESTS, { member: k11[0], label: 'SC7. an 11-of-11 multisig is the gate\'s identity; its first signer creates the gate' });
    const x = await mkAcct(MU, k11[0].publicKey, { amount: 100n });
    await send('SC7b. the first signer hands a dedicated account to the gate', true, handOver(g, x, k11[0].publicKey), [k11[0]]);
    const ixAllow = allowIx(g, x, 50n * U, k11.map((k) => k.publicKey));
    check('SC8. txShape: an 11-signer allow is over 1,232 bytes as a legacy transaction, and fits as a version 0 transaction with a lookup table only when one of the signers pays the fee (a separate relayer adds a 12th signature: too large even with the table)', sc.txShape([ixAllow], k11[0].publicKey) === 'v0+lookup-table' && sc.txShape([ixAllow], payer.publicKey) === 'too-large' && sc.legacySize([ixAllow], k11[0].publicKey) > 1232, `legacy ${sc.legacySize([ixAllow], k11[0].publicKey)} B, v0 ${sc.v0BestSize([ixAllow], k11[0].publicKey)} B, with a relayer ${sc.v0BestSize([ixAllow], payer.publicKey)} B`);
    await send('SC8b. sent as a legacy transaction (the first signer pays): refused (too large)', false, [ixAllow], k11, /too large|1232/i, { feePayer: k11[0] });
    const slot = await conn.getSlot('finalized'), lt = sc.lookupTableIxs(payer.publicKey, slot, [g.addr, x, TOKEN_PROGRAM_ID, M11.key, g.cap]);
    await must('lut', lt.ixs, []); await sleep(1800);
    const table = (await conn.getAddressLookupTable(lt.table)).value!;
    const vt = sc.compileV0(k11[0].publicKey, (await conn.getLatestBlockhash('confirmed')).blockhash, [ixAllow], table); vt.sign(k11);
    if (process.env.GATE_DEBUG) console.log('table', table.state.addresses.length, 'static', vt.message.staticAccountKeys.length, 'lookups', JSON.stringify(vt.message.addressTableLookups.map((l) => [l.writableIndexes, l.readonlyIndexes])));
    await lib.sendV0('SC8c. the same allow as a version 0 transaction with a lookup table for the non-signer accounts: fits and runs', true, vt, { cost: 'allow by 11 signers (v0 + lookup table)' });
    check('SC8d. the cap is 50', (await acct(x)).delegatedAmount === 50n * U);
    const relIx = releaseIx(g, x, newKey.publicKey, k11.map((k) => k.publicKey));
    const vr = sc.compileV0(k11[0].publicKey, (await conn.getLatestBlockhash('confirmed')).blockhash, [relIx], table); vr.sign(k11);
    await lib.sendV0('SC8e. the release by 11 signers as a version 0 transaction', true, vr, { cost: 'release by 11 signers (v0 + lookup table)' }); }
});

await section('Y', 'nothing writes the gate account after creation', async () => {
  const g = await mkGate(MS.key, P, DESTS), x = await mkOwned(g, MU, 500n), before = (await conn.getAccountInfo(g.addr))!.data;
  await setCap(g, x, 100n);
  await send('', true, [await ownersDraw(g, x, vin, 5n)], own2, undefined, { quiet: true });
  await send('', true, [await ownersRec(g, x, 5n)], own2, undefined, { quiet: true });
  await send('', true, [allowIx(g, x, 10n * U, pks(lowerBy))], lowerBy, undefined, { quiet: true });
  await send('', true, [releaseIx(g, x, newKey.publicKey, custodyBoth.map((k) => k.publicKey))], custodyBoth, undefined, { quiet: true });
  const after = (await conn.getAccountInfo(g.addr))!;
  check('Y1. after a draw, a recovery, a cap change and a release the gate account is byte for byte what create wrote', after.data.equals(before) && after.owner.equals(GATE), `${after.data.length} B`);
});

await section('B', 'the boundary second: a call that executes in the second of the end time or of its not-after is allowed', async () => {
  // Attempts run every 300 ms across the boundary. Each lands in a block with a clock second; the outcome must follow the clock (allowed up to and including the boundary second) and at least one attempt must land in the boundary second.
  const probe = async (build: (t: number) => Promise<{ ixs: TransactionInstruction[]; t: number }>, name: string, expectCode: RegExp) => {
    for (let round = 0; round < 4; round++) {
      const { ixs, t } = await build(round), seen: { at: number; ok: boolean; log: string }[] = [];
      while ((await chainNow()) < t - 2) await sleep(200);
      while ((await chainNow()) <= t + 2) {
        const tx = new lib.Transaction().add(...ixs); tx.feePayer = payer.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash; tx.sign(payer, ...own2);
        let sig = ''; try { sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true }); await lib.confirm(sig); } catch (e: any) { sig = e?.signature ?? ''; }
        const r = sig ? await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }) : null;
        if (r?.blockTime) seen.push({ at: r.blockTime, ok: r.meta?.err === null, log: (r.meta?.logMessages ?? []).join(' ') });
        await sleep(300);
      }
      const hit = seen.filter((x) => x.at === t), consistent = seen.every((x) => x.ok === (x.at <= t) && (x.ok || expectCode.test(x.log)));
      if (hit.length === 0 && consistent) continue;       // no attempt landed in the boundary second: try again with a later boundary
      return record(name, true, consistent && hit.length > 0 && hit.every((x) => x.ok), `${seen.length} attempts, ${hit.length} in the boundary second ${t}: ${seen.map((x) => `${x.at - t}${x.ok ? '+' : '-'}`).join(' ')}`);
    }
    return record(name, true, false, 'no attempt landed in the boundary second in 4 rounds');
  };
  const g0 = async (until: number) => { const g = await mkGate(MS.key, P, DESTS, { until, window: 60 }), x = await mkOwned(g, MU, 200n); await setCap(g, x, 150n); return { g, x }; };
  await probe(async () => { const t = (await chainNow()) + 9, { g, x } = await g0(t); return { t, ixs: [viaOwners(P, own2, AL, [transferIx({ gate: g, lane: P.vault(AL), src: x, dst: vin, amount: 1n * U, notAfter: t + 40 })])] }; },
    'B1. a venue draw is allowed in the end time\'s own second and refused after it', /custom program error: 0x2\b/);
  await probe(async () => { const t = (await chainNow()) + 9, { g, x } = await g0(FAR); return { t, ixs: [viaOwners(P, own2, AL, [transferIx({ gate: g, lane: P.vault(AL), src: x, dst: vin, amount: 1n * U, notAfter: t })])] }; },
    'B2. a call is allowed in its not-after\'s own second and refused after it', /custom program error: 0x4\b/);
});
const rc = finish(); process.exit(rc ? 1 : 0);
