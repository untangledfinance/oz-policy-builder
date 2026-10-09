// Gate-owned custody flow on Solana devnet: the a4-min harness logic (gate-spike/a4-min/gate-a4.ts) against the final gate deployed on devnet.
// Custody's identity is a weighted SPL multisig [custody, backup, trustee, trustee], m = 3. The Prime Account is a Squads Smart Account (3 owners, threshold 2) set up with plain local keys.
// Refused attempts fail in the preflight simulation (no signature, no fee). Run: bun gate-devnet.ts
import * as lib from './lib-devnet.ts';
import * as sc from './setup-checks.ts';
const { AL, OL, E, D, GATE, U, SOL, TOKEN_PROGRAM_ID, OWNER_MISMATCH, conn, payer, custody, backup, trustee, stranger, newKey, agent, other, owners, st, save, send, must, check, mkMint, mkAcct, mkMs, mkAta, ata, acct, bal, info, fmt, acts,
  createIx, transferIx, allowIx, releaseIx, handOver, gateAddr, capAddr, newSeed, Prime, viaOwners, viaPolicy, installRule, pin, dc, agentKey, later, chainNow, fundFromPayer, finish, sa, ix, m, Keypair, PublicKey, SystemProgram,
  last, createCloseAccountInstruction } = lib;
type Gate = lib.Gate;

const t0 = Date.now(), startBal = await conn.getBalance(payer.publicKey);
console.log(`gate ${GATE.toBase58()} payer ${(startBal / SOL).toFixed(6)} SOL`);
st.startLamports = startBal; st.metrics = {}; save();
const metric = (label: string) => { st.metrics[label] = { cu: last.cu, bytes: last.bytes }; save(); };
const own2 = [owners[0], owners[1]], pks = (ks: lib.Keypair[]) => ks.map((k) => k.publicKey);
const vaultSigns = (i: lib.TransactionInstruction) => { i.keys[i.keys.length - 1].isWritable = true; return i; };

// ── S. Setup ───────────────────────────────────────────────────────────────────────────────────
console.log('--- S: setup');
await fundFromPayer(custody.publicKey, 5_000_000, 'fund custody with the gate account rent');
await fundFromPayer(trustee.publicKey, 3_000_000, 'fund the trustee with the rent of a rogue gate');
const P = await new Prime(owners, 2).create('S1. the Prime Account (Squads Smart Account) is set up with three plain owner keys, threshold 2, no settings authority');
st.prime = P.settings.toBase58(); save();
{ const s: any = await sa.accounts.Settings.fromAccountAddress(conn, P.settings);
  check('S1b. the account reads back: threshold 2, three owners with full permissions, no settings authority, no time lock',
    s.threshold === 2 && s.signers.length === 3 && owners.every((o) => s.signers.some((x: any) => x.key.equals(o.publicKey) && x.permissions.mask === 7)) && s.settingsAuthority.equals(PublicKey.default) && s.timeLock === 0, `threshold ${s.threshold}, ${s.signers.length} owners`); }
const MU = await mkMint(); st.mint = MU.toBase58(); save();
{ const a = (await conn.getAccountInfo(MU))!, r = sc.checkMint({ owner: a.owner, data: a.data });
  check('S2. the mint is a classic Token mint with no freeze authority and no extension: the app\'s checkMint finds nothing to refuse or warn about', a.data.length === 82 && r.program === 'token' && r.refuse.length === 0 && r.warn.length === 0, `${a.data.length} B`); }
const v1U = ata(MU, P.vault(AL)), tU = ata(MU, trustee.publicKey), sU = ata(MU, stranger.publicKey);
await must('create the token accounts of the Prime vault 1, the trustee wallet and a stranger', [mkAta(MU, P.vault(AL)), mkAta(MU, trustee.publicKey), mkAta(MU, stranger.publicKey)], []);
const MW = await mkMs('S3. custody\'s identity: the weighted multisig [custody, backup, trustee, trustee], m = 3', sc.weightedSlots([custody.publicKey, backup.publicKey], trustee.publicKey, 3), 3);
st.multisig = MW.key.toBase58(); save();
{ const a = (await conn.getAccountInfo(MW.key))!, ms = sc.parseMultisig(a.data);
  check('S3b. checkMultisig is clean: m = 3, n = 4, the trustee holds weight 2, custody and its backup together hold weight 2', a.owner.equals(TOKEN_PROGRAM_ID) && ms.m === 3 && ms.n === 4 && sc.checkMultisig(ms, { custody: [custody.publicKey, backup.publicKey], trustee: trustee.publicKey }).length === 0
    && sc.weight(ms, [trustee.publicKey]) === 2 && sc.weight(ms, [custody.publicKey, backup.publicKey]) === 2, `${a.data.length} B`); }

// ── G. The gate and the app's read-back ────────────────────────────────────────────────────────
console.log('--- G: create the gate');
const FAR = (await chainNow()) + 7 * 86_400, seed0 = newSeed();
const mkGateSeed = (s: Buffer): Gate => ({ addr: gateAddr(MW.key, P.settings, s), cap: capAddr(gateAddr(MW.key, P.settings, s)), ms: MW.key, prime: P, seed: s });
const g = mkGateSeed(seed0);
await send('G1. custody (a signer of the multisig) creates the gate: Prime Account P, agent lane vault 1, owners lane vault 3, window 60 s, recovery = the trustee\'s wallet, one listed destination (vault 1)', true,
  [createIx(custody.publicKey, MW.key, P, [P.vault(AL)], { seed: seed0, recovery: trustee.publicKey }, FAR)], [custody]); metric('create gate');
st.gateAccount = g.addr.toBase58(); save();
const want: sc.ExpectedGate = { program: GATE, multisig: MW.key, settings: P.settings, agentLane: P.vault(AL), ownersLane: P.vault(OL), recovery: trustee.publicKey, until: FAR, window: 60, seed: seed0, destinations: [P.vault(AL)], custody: [custody.publicKey, backup.publicKey] };
const read = async (a: lib.PublicKey) => { const x = (await conn.getAccountInfo(a))!; return { address: a, owner: x.owner, data: x.data }; };
{ const a = await read(g.addr), r = sc.checkGate(a, want);
  check('G1b. the app\'s checkGate reads the live gate back and finds no difference from the plan; the address it derives is the one the program made', r.length === 0 && sc.gateAddress(GATE, MW.key, P.settings, seed0)[0].equals(g.addr), `${a.data.length} B ${r.map((x) => x.code).join()}`);
  const s = sc.parseGate(a.data);
  check('G1c. the gate account is owned by the gate program and holds recovery = the trustee, the end time, window 60, the seed and one destination (213 B, rent-exempt)', a.owner.equals(GATE) && s.recovery.equals(trustee.publicKey) && Number(s.until) === FAR && s.window === 60 && s.destinations.length === 1 && a.data.length === 213
    && (await conn.getBalance(g.addr)) >= (await conn.getMinimumBalanceForRentExemption(213)), `${a.data.length} B`); }
{ const attacker = Keypair.generate().publicKey, s2 = newSeed(), rogue = mkGateSeed(s2);
  await send('G2. a rogue member of the multisig (the trustee) creates a second gate whose recovery address is its own choice', true, [createIx(trustee.publicKey, MW.key, P, [P.vault(AL)], { seed: s2, recovery: attacker }, FAR)], [trustee]);
  const r = sc.checkGate(await read(rogue.addr), { ...want, seed: s2 });
  check('G2b. checkGate refuses it: the stored recovery address differs from the one custody and the owners expect', r.length === 1 && r[0].code === 'gate-recovery' && r[0].message.includes(attacker.toBase58()), r.map((x) => x.code).join()); }
await send('G3. a stranger (not a signer of the multisig) names the multisig: refused', false, [createIx(stranger.publicKey, MW.key, P, [P.vault(AL)], { seed: newSeed(), recovery: trustee.publicKey }, FAR)], [stranger], E.wrong);
await send('G4. custody\'s wallet (System program) named as the multisig: refused', false, [createIx(custody.publicKey, custody.publicKey, P, [P.vault(AL)], { seed: newSeed(), recovery: trustee.publicKey }, FAR)], [custody], E.wrong);
await send('G5. the same gate again is refused (the address is taken)', false, [createIx(custody.publicKey, MW.key, P, [P.vault(AL)], { seed: seed0, recovery: trustee.publicKey }, FAR)], [custody], E.inUse);
await send('G6. agent lane 0 (where session rules sign) is refused', false, [createIx(custody.publicKey, MW.key, P, [P.vault(AL)], { seed: newSeed(), recovery: trustee.publicKey, agentLane: 0 }, FAR)], [custody], E.invalidData);

// ── H. Hand-over ───────────────────────────────────────────────────────────────────────────────
console.log('--- H: hand-over');
const X = await mkAcct(MU, custody.publicKey, { amount: 1000n, label: 'create custody\'s dedicated token account X and fund it with 1,000 tokens' }); st.sourceAccount = X.toBase58(); save();
check('H0. before the hand-over custody is the owner of X and holds 1,000', (await acct(X)).owner.equals(custody.publicKey) && (await bal(X)) === 1000n * U, await info(X));
{ const hs = handOver(g, X, custody.publicKey);
  check('H1. the hand-over builds the close authority first, then the owner, both to the gate PDA', hs[0].data[0] === 6 && hs[0].data[1] === 3 && hs[1].data[0] === 6 && hs[1].data[1] === 2 && hs[0].data.subarray(3, 35).equals(g.addr.toBuffer()), 'SetAuthority(CloseAccount), SetAuthority(AccountOwner)');
  await send('H1b. custody signs the two SetAuthority calls in one transaction', true, hs, [custody]); metric('hand over a token account (2 SetAuthority)'); }
{ const a = await acct(X), raw = (await conn.getAccountInfo(X))!.data;
  check('H2. read-back: owner = gate, close authority = gate, no delegate', a.owner.equals(g.addr) && a.closeAuthority?.equals(g.addr) === true && a.delegate === null, await info(X));
  check('H2b. the app\'s checkHandedOver and checkSourceAccount read the same bytes back as clean', sc.checkHandedOver(raw, g.addr).length === 0 && sc.checkSourceAccount(X, raw, TOKEN_PROGRAM_ID).length === 0); }
{ const before = await bal(X), dstS = sU;
  for (const [tag, name, who] of [['H3', 'custody alone', [custody]], ['H4', 'the trustee alone', [trustee]], ['H5', 'a stranger', [stranger]]] as [string, string, lib.Keypair[]][]) {
    const by = acts(X, who[0].publicKey, []);
    await send(`${tag}a. ${name}: transfer out of the gate-owned account`, false, [by.transfer(dstS, 10n)], who, OWNER_MISMATCH);
    await send(`${tag}b. ${name}: SetAuthority(AccountOwner) back to a key`, false, [by.setOwner(who[0].publicKey)], who, OWNER_MISMATCH);
    await send(`${tag}c. ${name}: SetAuthority(CloseAccount)`, false, [by.setCloser(who[0].publicKey)], who, OWNER_MISMATCH); }
  const byMs = acts(X, MW.key, [custody, backup, trustee]);
  await send('H6. custody, the backup and the trustee name the multisig as the owner and all sign: refused (the multisig is not the owner, the gate is)', false, [byMs.transfer(sU, 10n)], [custody, backup, trustee], OWNER_MISMATCH);
  check('H7. no refused action moved anything', (await bal(X)) === before && (await bal(sU)) === 0n, fmt(await bal(X))); }

// ── R. The agent's rule and the cap ────────────────────────────────────────────────────────────
console.log('--- R: the agent rule and the cap');
const RULE = await installRule('R1. the owners (2 of 3) install the agent rule at lane 1: the gate\'s transfer from X, amount 1 to 100, a deadline set', P,
  [{ programId: GATE, accountConstraints: [pin(0, g.addr), pin(2, X)], dataConstraints: [dc('U8', 0, 1, D.Equals), dc('U64Le', 1, 1n * U, D.GreaterThanOrEqualTo), dc('U64Le', 1, 100n * U, D.LessThanOrEqualTo), dc('U64Le', 9, 1, D.GreaterThanOrEqualTo)] }],
  [agentKey(agent)], 1);
st.rule = RULE.policy.toBase58(); st.ruleBytes = RULE.bytes; save(); metric('install the agent rule');
const draw = async (dst: lib.PublicKey, n: bigint, o: Partial<lib.Mv> = {}) => transferIx({ gate: g, lane: P.vault(AL), src: X, dst, amount: n * U, notAfter: await later(), ...o });
const agentMove = async (ixn: lib.TransactionInstruction) => viaPolicy(P, RULE.policy, [agent], [ixn], [0]);
const ownersRec = async (dst: lib.PublicKey, n: bigint, o: Partial<lib.Mv> = {}) => viaOwners(P, own2, OL, [transferIx({ gate: g, lane: P.vault(OL), src: X, dst, amount: n * U, notAfter: await later(), ...o })]);
await send('R2. before any cap the agent cannot draw: the cap PDA is no owner and no delegate (the token program refuses)', false, [await agentMove(await draw(v1U, 5n))], [agent], OWNER_MISMATCH);
await send('R3. custody alone sets the first cap (a raise): refused, the multisig threshold is needed', false, [allowIx(g, X, 100n * U, [custody.publicKey])], [custody], E.lane);
await send('R3b. custody and the backup (weight 2 of 3): refused', false, [allowIx(g, X, 100n * U, pks([custody, backup]))], [custody, backup], E.lane);
await send('R3c. the trustee alone (weight 2 of 3): refused', false, [allowIx(g, X, 100n * U, [trustee.publicKey])], [trustee], E.lane);
await send('R3d. a stranger: refused', false, [allowIx(g, X, 100n * U, [stranger.publicKey])], [stranger], E.lane);
await send('R4. custody and the trustee (weight 3 of 3) set the cap to 100', true, [allowIx(g, X, 100n * U, pks([custody, trustee]))], [custody, trustee]); metric('allow: the multisig threshold sets the cap');
{ const a = await acct(X);
  check('R4b. the delegate is the cap PDA with 100 delegated, and the gate still owns the account', a.delegate?.equals(g.cap) === true && a.delegatedAmount === 100n * U && a.owner.equals(g.addr), await info(X)); }

console.log('--- M: agent moves');
{ const v0 = await bal(v1U), x0 = await bal(X);
  await send('M1. the agent moves 10 to the listed destination (the Prime vault 1 account) through the Squads rule', true, [await agentMove(await draw(v1U, 10n))], [agent]); metric('agent move through a Squads rule');
  check('M1b. the destination gained 10, X lost 10, the cap fell to 90', (await bal(v1U)) - v0 === 10n * U && x0 - (await bal(X)) === 10n * U && (await acct(X)).delegatedAmount === 90n * U, await info(X)); }
await send('M2. the agent moves to an unlisted destination (a stranger\'s account): refused by the gate', false, [await agentMove(await draw(sU, 1n))], [agent], E.dest);
await send('M3. the agent moves to the recovery address (the trustee\'s account): refused by the gate, recovery is no listed destination', false, [await agentMove(await draw(tU, 1n))], [agent], E.dest);
await send('M4. the agent asks 95 with 90 left under the cap: refused by the token program', false, [await agentMove(await draw(v1U, 95n))], [agent], E.funds);
await send('M5. the agent asks 101 (above the rule\'s band): refused by the rule', false, [await agentMove(await draw(v1U, 101n))], [agent], E.num);
await send('M6. a deadline that has passed: refused by the gate', false, [await agentMove(await draw(v1U, 1n, { notAfter: (await chainNow()) - 5 }))], [agent], E.window);
await send('M7. the agent calls allow (raise the cap) under the rule: refused by the rule', false, [viaPolicy(P, RULE.policy, [agent], [vaultSigns(allowIx(g, X, 500n * U, [P.vault(AL)]))], [0])], [agent], E.rule);
await send('M8. the agent calls release under the rule: refused by the rule', false, [viaPolicy(P, RULE.policy, [agent], [vaultSigns(releaseIx(g, X, agent.publicKey, [P.vault(AL)]))], [0])], [agent], E.rule);
await send('M9. a stranger signs as the agent lane vault: refused by the gate', false, [transferIx({ gate: g, lane: stranger.publicKey, src: X, dst: v1U, amount: U, notAfter: await later() })], [stranger], E.lane);
await send('M10. a cap PDA that is not this gate\'s: refused by the runtime (the gate cannot sign for it)', false, [await agentMove(await draw(v1U, 1n, { cap: capAddr(PublicKey.default) }))], [agent], E.priv);

console.log('--- L: one custody signer lowers the cap');
await send('L1. custody alone lowers the cap from 90 to 5', true, [allowIx(g, X, 5n * U, [custody.publicKey])], [custody]); metric('allow: one signer lowers the cap');
check('L1b. 5 delegated, the delegate is still the cap PDA', (await acct(X)).delegatedAmount === 5n * U && (await acct(X)).delegate?.equals(g.cap) === true, await info(X));
await send('L2. the agent asks 20 after the cap was lowered: refused by the token program', false, [await agentMove(await draw(v1U, 20n))], [agent], E.funds);
await send('L3. a single signer raises the cap again (5 to 50): refused, a raise needs the threshold', false, [allowIx(g, X, 50n * U, [custody.publicKey])], [custody], E.lane);
await send('L3b. the trustee alone raises it: refused', false, [allowIx(g, X, 50n * U, [trustee.publicKey])], [trustee], E.lane);
await send('L4. control: the agent moves exactly 5, the lowered cap', true, [await agentMove(await draw(v1U, 5n))], [agent]);
check('L4b. the cap is used up: the token program cleared the delegate', (await acct(X)).delegate === null && (await acct(X)).delegatedAmount === 0n, await info(X));
await send('L5. the next agent move is refused by the token program: the cap PDA is no owner, so no unlimited path follows', false, [await agentMove(await draw(v1U, 1n))], [agent], OWNER_MISMATCH);
await send('L6. custody and the trustee set the cap to 100 again', true, [allowIx(g, X, 100n * U, pks([custody, trustee]))], [custody, trustee]);

console.log('--- C: recovery by the owners');
{ const t0b = await bal(tU), x0 = await bal(X);
  check('C0. before the recovery: the cap is 100 and X holds 985', (await acct(X)).delegatedAmount === 100n * U && x0 === 985n * U, await info(X));
  await send('C1. the owners (2 of 3) as the owners lane recover 300 to the trustee\'s wallet account: above the cap of 100', true, [await ownersRec(tU, 300n)], own2); metric('recovery by the owners (2 of 3, above the cap)');
  check('C1b. the trustee\'s account gained 300, X lost 300, the cap is untouched at 100', (await bal(tU)) - t0b === 300n * U && x0 - (await bal(X)) === 300n * U && (await acct(X)).delegatedAmount === 100n * U, await info(X)); }
await send('C2. one owner alone as the owners lane (threshold 2): refused by Squads', false, [viaOwners(P, [owners[0]], OL, [transferIx({ gate: g, lane: P.vault(OL), src: X, dst: tU, amount: U, notAfter: await later() })])], [owners[0]], E.signers);
await send('C3. the owners lane pays a listed agent destination: refused, recovery goes to the recovery address only', false, [await ownersRec(v1U, 1n)], own2, E.dest);
await send('C4. the owners lane pays a stranger: refused', false, [await ownersRec(sU, 1n)], own2, E.dest);
await send('C5. the owners lane with a deadline that has passed: refused', false, [await ownersRec(tU, 1n, { notAfter: (await chainNow()) - 5 })], own2, E.window);
await send('C6. the owners sign as vault 2 (no lane of this gate): refused', false, [viaOwners(P, own2, 2, [transferIx({ gate: g, lane: P.vault(2), src: X, dst: tU, amount: U, notAfter: await later() })])], own2, E.lane);

console.log('--- T: release by the multisig');
const rel = (src: lib.PublicKey, by: lib.Keypair[]) => releaseIx(g, src, newKey.publicKey, pks(by));
await send('T1. custody alone releases X: refused (weight 1 of 3)', false, [rel(X, [custody])], [custody], E.lane);
await send('T1b. custody and the backup (weight 2 of 3): refused', false, [rel(X, [custody, backup])], [custody, backup], E.lane);
await send('T1c. the trustee alone (weight 2 of 3): refused', false, [rel(X, [trustee])], [trustee], E.lane);
await send('T1d. the owners of the Prime Account cannot release (the agent lane vault signs; it is no multisig signer)', false, [viaOwners(P, own2, AL, [vaultSigns(releaseIx(g, X, newKey.publicKey, [P.vault(AL)]))])], own2, E.lane);
{ const b0 = await bal(X);
  await send('T2. custody and the trustee (weight 3 of 3) release X to newKey', true, [rel(X, [custody, trustee])], [custody, trustee]); metric('release by the multisig');
  const a = await acct(X);
  check('T2b. owner = newKey, close authority = newKey, delegate and cap cleared, balance intact', a.owner.equals(newKey.publicKey) && a.closeAuthority?.equals(newKey.publicKey) === true && a.delegate === null && a.delegatedAmount === 0n && a.amount === b0, await info(X)); }
await send('T3. newKey alone moves 50 out: full control is back', true, [acts(X, newKey.publicKey, []).transfer(v1U, 50n)], [newKey]);
await send('T4. the agent lane is refused by the gate after the release (the source is no longer its own)', false, [await agentMove(await draw(v1U, 1n))], [agent], E.wrong);
await send('T5. recovery is refused too (the gate is no longer the owner)', false, [await ownersRec(tU, 1n)], own2, OWNER_MISMATCH);
await send('T6. a second release of the same account: refused by the token program', false, [rel(X, [custody, trustee])], [custody, trustee], OWNER_MISMATCH);
{ const Y = await mkAcct(MU, custody.publicKey, { amount: 10n, label: 'create a second dedicated account Y of custody with 10 tokens' }); st.sourceAccountY = Y.toBase58(); save();
  await send('T7. custody hands Y to the gate: close authority first, then owner', true, handOver(g, Y, custody.publicKey), [custody]);
  check('T7b. read-back is clean', sc.checkHandedOver((await conn.getAccountInfo(Y))!.data, g.addr).length === 0, await info(Y));
  await send('T7c. custody\'s key is lost: custody and the backup (weight 2) cannot release Y', false, [rel(Y, [custody, backup])], [custody, backup], E.lane);
  await send('T7d. the trustee and the backup (weight 3) release Y to newKey with no custody signature', true, [rel(Y, [trustee, backup])], [trustee, backup]);
  check('T7e. owner = newKey', (await acct(Y)).owner.equals(newKey.publicKey), await info(Y)); }

// ── F. The forged multisig ─────────────────────────────────────────────────────────────────────
console.log('--- F: forged multisig');
{ let K: lib.Keypair, mk: lib.Keypair, tries = 0;
  do { K = Keypair.generate(); tries++; } while (K.publicKey.toBytes()[0] !== 0 || K.publicKey.toBytes()[1] !== 0);
  do { mk = Keypair.generate(); } while (mk.publicKey.toBytes()[0] !== 0);
  console.log(`key with two leading zero bytes after ${tries} tries`);
  await mkMint(mk);
  const ca = new PublicKey(Buffer.concat([Buffer.from(K.publicKey.toBytes().slice(2)), Buffer.from([7, 7])]));
  const F = await mkAcct(mk.publicKey, payer.publicKey, { closeAuth: ca, label: 'create the lookalike: a token account whose mint address starts with a zero byte and whose close authority carries a key in a signer slot' });
  const fd = (await conn.getAccountInfo(F))!;
  check('F1. the token account is 165 bytes, owned by the Token program, byte 0 (read as m) is 0 and bytes 131..163 (signer slot 4) equal the key', fd.data.length === 165 && fd.owner.equals(TOKEN_PROGRAM_ID) && fd.data[0] === 0 && Buffer.from(fd.data.slice(131, 163)).equals(K.publicKey.toBuffer()), `m ${fd.data[0]} n ${fd.data[1]}`);
  await send('F2. the ground key names the token account as the multisig and creates a gate: refused by the gate (length check), the identity must be a real 355-byte multisig', false,
    [createIx(K.publicKey, F, P, [P.vault(AL)], { seed: newSeed(), recovery: trustee.publicKey }, FAR)], [K], E.wrong);
  let parsed = ''; try { parsed = JSON.stringify(sc.checkMultisig(sc.parseMultisig(fd.data), { custody: [custody.publicKey], trustee: trustee.publicKey }).map((i) => i.code)); } catch (e) { parsed = 'throws: ' + String((e as Error).message).slice(0, 100); }
  check('F3. the app\'s parseMultisig refuses the token account as a multisig', parsed.startsWith('throws'), parsed);
  await send('F4. control: a gate on the real multisig is still created', true, [createIx(custody.publicKey, MW.key, P, [P.vault(AL)], { seed: newSeed(), recovery: trustee.publicKey }, FAR)], [custody]); }

const fails = finish();
const endBal = await conn.getBalance(payer.publicKey);
st.endLamports = endBal; st.seconds = Math.round((Date.now() - t0) / 1000); save();
console.log(`payer ${(startBal / SOL).toFixed(6)} -> ${(endBal / SOL).toFixed(6)} SOL (spent ${((startBal - endBal) / SOL).toFixed(6)}), ${st.seconds} s`);
process.exit(fails ? 1 : 0);
