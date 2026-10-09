// a4-min venue run: real Orca Whirlpool and Kamino Lend programs with mainnet pool and reserve state cloned onto the local validator (run-validator.sh with VENUES=1), the gate-owned custody
// gate, custody's multisig, the agent's rule, the whole-batch time lock on a real Orca swap, recovery of real venue funds and prime-session in the path.
// Path in every run: the agent key (a policy signer) -> Squads checks Prime's rule -> gate.transfer draws from custody's gate-owned USDC account into the Prime vault's account -> the venue call runs
// signed by the same vault -> proceeds land in custody's gate-owned accounts. Run it within about two minutes of the validator start (the cloned Scope price feed goes stale after 180 s).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ed25519Program, SYSVAR_INSTRUCTIONS_PUBKEY } from '@solana/web3.js';
import * as lib from './lib';
import * as sc from './setup-checks';
const { AL, OL, E, D, GATE, HOSTILE, OWNER_MISMATCH, U, TOKEN_PROGRAM_ID, conn, payer, custody, trustee, stranger, newKey, recovery, agent, owners, st, costs, save, send, must, check, record, mkAcct, mkMs, mkAta, mkGate, ata,
  acct, bal, fmt, transferIx, allowIx, releaseIx, handOver, Prime, viaOwners, viaPolicy, installRule, store, runStored, statusOf, propTime, pin, dc, agentKey, voteOnly, later, chainNow, until, finish, sa, ix, m, u64, i64, kp, sleep, last,
  Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, AddressLookupTableProgram, ComputeBudgetProgram, createApproveInstruction, createMintToInstruction, createTransferInstruction, NAMES, PSID, SQUADS } = lib;

const V = JSON.parse(readFileSync(`${lib.here}venues/venues.json`, 'utf8')); const K = (s: string) => new PublicKey(s);
const WHIRL = K('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'), KLEND = K('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
NAMES[WHIRL.toBase58()] = 'orca'; NAMES[KLEND.toBase58()] = 'klend';
const USDC = K(V.usdc.mint), USDT = K(V.orca.mintB), CMINT = K(V.kamino.collateralMint), usdcAuth = kp('usdc-authority');
const pool = K(V.orca.pool), vaultA = K(V.orca.vaultA), vaultB = K(V.orca.vaultB), oracle = K(V.orca.oracle), tickAt = (s: number) => K(V.orca.ticks.find((t: any) => t.start === s).addr);
const reserve = K(V.kamino.reserve), market = K(V.kamino.market), supply = K(V.kamino.supplyVault), scope = K(V.kamino.scope), lma = K(V.kamino.marketAuthority);
const own2 = [owners[0], owners[1]], own2b = [owners[1], owners[2]], both = [custody, trustee];
const lowerBy = process.env.GATE_VARIANT === 'thr' ? both : [custody];
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const u128 = (n: bigint) => Buffer.concat([u64(n & 0xffffffffffffffffn), u64(n >> 64n)]);
const same = (a: any, b: any) => JSON.stringify(a, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) === JSON.stringify(b, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
const cb = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
const trace = async (sig: string) => {   // stack height of every invoke in a transaction, from its logs
  const logs = (await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))?.meta?.logMessages ?? []; const seen: Record<string, number> = {}; let max = 0;
  for (const l of logs) { const g = l.match(/^Program (\S+) invoke \[(\d+)\]/); if (g) { const n = NAMES[g[1]] ?? g[1].slice(0, 6), h = Number(g[2]); seen[n] = Math.max(seen[n] ?? 0, h); max = Math.max(max, h); } }
  return { max, seen: JSON.stringify(seen) }; };
const depth = async (label: string) => { if (lib.last.sig) { const t = await trace(lib.last.sig); console.log(`    stack heights: max ${t.max}; ${t.seen}`); costs[`depth: ${label}`] = { max: t.max, seen: t.seen }; } };

const P = await new Prime(owners, 2).create();
const vault = P.vault(AL);
const MS = await mkMs('', [custody.publicKey, trustee.publicKey], 2);
const vU = ata(USDC, vault), vK = ata(CMINT, vault), rU = ata(USDC, recovery.publicKey);
await must('atas', [mkAta(USDC, vault), mkAta(CMINT, vault), mkAta(USDC, recovery.publicKey), mkAta(USDC, stranger.publicKey), mkAta(USDT, stranger.publicKey)], []);
console.log('--- V0 setup: custody holds 100,000 USDC in a gate-owned account (the mint authority is a local key; the pool, reserve, vaults and programs are mainnet state)');
{ const pa = await conn.getAccountInfo(pool), ra = await conn.getAccountInfo(reserve);
  check('V0a. the cloned Orca pool is the mainnet USDC/USDT whirlpool and the Kamino reserve is the mainnet USDC reserve', pa?.owner.equals(WHIRL) === true && pa.data.length === 653 && ra?.owner.equals(KLEND) === true && (await conn.getAccountInfo(WHIRL))?.executable === true && (await conn.getAccountInfo(KLEND))?.executable === true, `pool ${pa?.data.length} B, reserve ${ra?.data.length} B`); }
const g = await mkGate(MS.key, P, [vault], { window: 60, label: 'V1. custody (a multisig signer) creates the gate GV for P: agent lane 1, owners lane 3, the Prime vault (lane 1) is the one listed destination, window 60 s, recovery R', cost: 'create gate (1 destination)' });
const dedicated = async (mint: PublicKey, amount = 0n, authority?: lib.Keypair) => {
  const a = await mkAcct(mint, custody.publicKey);
  if (amount) await must('mint', [createMintToInstruction(mint, a, (authority ?? payer).publicKey, amount * U)], authority ? [authority] : []);
  await must('hand over', handOver(g, a, custody.publicKey), [custody]);
  return a;
};
const cU = await dedicated(USDC, 100_000n, usdcAuth), cT = await dedicated(USDT), cK = await dedicated(CMINT);
check('V1b. custody\'s USDC, USDT and collateral accounts are dedicated accounts owned by the gate (owner and close authority); setup-checks reads each back clean', [cU, cT, cK].every((a) => true) &&
  (await Promise.all([cU, cT, cK].map(async (a) => sc.checkHandedOver((await conn.getAccountInfo(a))!.data, g.addr).length === 0 && sc.checkSourceAccount(a, (await conn.getAccountInfo(a))!.data, TOKEN_PROGRAM_ID).length === 0))).every(Boolean), `USDC ${fmt(await bal(cU))}`);
await send('V2. the multisig threshold (custody and the trustee) sets a cap of 10,000 USDC on the USDC account', true, [allowIx(g, cU, 10_000n * U, both.map((k) => k.publicKey))], both);
const draw = (src: PublicKey, dst: PublicKey, amount: bigint, by?: number) => transferIx({ gate: g, lane: vault, src, dst, amount, notAfter: by ?? Math.floor(Date.now() / 1000) + 40 });
const drawNow = async (src: PublicKey, dst: PublicKey, amount: bigint) => transferIx({ gate: g, lane: vault, src, dst, amount, notAfter: await later(40) });
const transferC = (src: PublicKey, dst: PublicKey, lo: bigint, hi: bigint) => ({ programId: g.gp, accountConstraints: [pin(0, g.addr), pin(2, src), pin(3, dst)],
  dataConstraints: [dc('U8', 0, 1, D.Equals), dc('U64Le', 1, lo * U, D.GreaterThanOrEqualTo), dc('U64Le', 1, hi * U, D.LessThanOrEqualTo), dc('U64Le', 9, 1, D.GreaterThanOrEqualTo)] });
const orca = (amount: bigint, minOut: bigint, o: { aToB?: boolean; ownerB?: PublicKey } = {}) => { const a2b = o.aToB ?? true;
  const ticks = (a2b ? [0, -88, -176] : [0, 88, 176]).map(tickAt);
  return new TransactionInstruction({ programId: WHIRL, data: Buffer.concat([Buffer.from('f8c69e91e17587c8', 'hex'), u64(amount), u64(minOut), u128(a2b ? 4295048016n : 79226673515401279992447579055n), Buffer.from([1, a2b ? 1 : 0])]),
    keys: [m(TOKEN_PROGRAM_ID), m(vault, true), m(pool, false, true), m(vU, false, true), m(vaultA, false, true), m(o.ownerB ?? cT, false, true), m(vaultB, false, true), ...ticks.map((t) => m(t, false, true)), m(oracle)] }); };
const refresh = () => new TransactionInstruction({ programId: KLEND, data: disc('refresh_reserve'), keys: [m(reserve, false, true), m(market), m(KLEND), m(KLEND), m(KLEND), m(scope)] });
const deposit = (amount: bigint, o: { dest?: PublicKey } = {}) => new TransactionInstruction({ programId: KLEND, data: Buffer.concat([disc('deposit_reserve_liquidity'), u64(amount)]),
  keys: [m(vault, true), m(reserve, false, true), m(market), m(lma), m(USDC), m(supply, false, true), m(CMINT, false, true), m(vU, false, true), m(o.dest ?? cK, false, true), m(TOKEN_PROGRAM_ID), m(TOKEN_PROGRAM_ID), m(SYSVAR_INSTRUCTIONS_PUBKEY)] });
const redeem = (amount: bigint) => new TransactionInstruction({ programId: KLEND, data: Buffer.concat([disc('redeem_reserve_collateral'), u64(amount)]),
  keys: [m(vault, true), m(market), m(reserve, false, true), m(lma), m(USDC), m(CMINT, false, true), m(supply, false, true), m(vK, false, true), m(vU, false, true), m(TOKEN_PROGRAM_ID), m(TOKEN_PROGRAM_ID), m(SYSVAR_INSTRUCTIONS_PUBKEY)] });
const sweep = (amount: bigint) => createTransferInstruction(vU, cU, vault, amount);
const snap = async () => ({ cu: await bal(cU), ct: await bal(cT), ck: await bal(cK), vu: await bal(vU), pa: await bal(vaultA), pb: await bal(vaultB), sup: await bal(supply) });
const show = (s: any) => Object.entries(s).map(([k, v]: any) => `${k} ${fmt(v)}`).join(', ');

console.log('--- V3 real deposit: Kamino Lend USDC reserve (gate draw into the Prime vault, refresh, deposit signed by the vault, collateral tokens to custody\'s gate-owned account)');
const dBand = [transferC(cU, vU, 1n, 1000n), { programId: KLEND, accountConstraints: [pin(1, reserve), pin(2, market), pin(7, vU), pin(8, cK)],
  dataConstraints: [dc('U8Slice', 0, new Uint8Array(disc('deposit_reserve_liquidity')), D.Equals), dc('U64Le', 8, 1n * U, D.GreaterThanOrEqualTo), dc('U64Le', 8, 1000n * U, D.LessThanOrEqualTo)] }];
const PKM = await installRule('V3. owners install rule PKM (agent alone): gate draw of 1 to 1,000 USDC into the vault, and the Kamino deposit with the reserve, market, source (vault) and collateral destination (custody\'s gate-owned account) pinned:', P, dBand, [agentKey(agent)], 1);
costs['rule PKM (gate draw + Kamino deposit)'] = { bytes: PKM.bytes, rent: PKM.rent };
{ const s0 = await snap();
  await send('V4. agent: refresh the reserve (top-level), then ONE Squads call: gate.transfer 100 USDC custody -> vault, klend deposit_reserve_liquidity signed by the vault, collateral tokens to custody', true,
    [cb, refresh(), viaPolicy(P, PKM.policy, [agent], [await drawNow(cU, vU, 100n * U), deposit(100n * U)], [0, 1], AL)], [agent], undefined, { cost: 'REAL Kamino deposit through the gate (agent, policy sync)' });
  await depth('Kamino deposit');
  const s1 = await snap();
  check('V5. custody lost 100 USDC and holds the Kamino collateral tokens in its gate-owned account, the vault holds nothing, the reserve supply vault gained 100', s0.cu - s1.cu === 100n * U && s1.ck > s0.ck && s1.vu === 0n && s1.sup - s0.sup === 100n * U, show(s1));
  st.kaminoCollateral = fmt(s1.ck - s0.ck); save(); }
await send('V6. the agent aims the deposit at its own collateral account (not custody\'s): refused by the rule', false, [cb, refresh(), viaPolicy(P, PKM.policy, [agent], [await drawNow(cU, vU, 10n * U), deposit(10n * U, { dest: vK })], [0, 1], AL)], [agent], E.acct);
await send('V7. 1,001 USDC (over the rule\'s band): refused by the rule', false, [cb, refresh(), viaPolicy(P, PKM.policy, [agent], [await drawNow(cU, vU, 1001n * U), deposit(1001n * U)], [0, 1], AL)], [agent], E.num);

console.log('--- V7b the way out: the collateral tokens come back through the same path (gate draw of collateral into the vault, redeem signed by the vault, USDC swept into custody\'s account)');
await send('V7b. the multisig threshold sets a cap of 1,000 collateral tokens on the collateral account', true, [allowIx(g, cK, 1000n * U, both.map((k) => k.publicKey))], both);
const PKR = await installRule('V7c. owners install rule PKR (agent alone): gate draw of 1 to 1,000 collateral tokens into the vault, the Kamino redeem (reserve and market pinned, the vault\'s accounts), and a token transfer from the vault to custody\'s USDC account only:', P,
  [transferC(cK, vK, 1n, 1000n), { programId: KLEND, accountConstraints: [pin(2, reserve), pin(1, market), pin(7, vK), pin(8, vU)], dataConstraints: [dc('U8Slice', 0, new Uint8Array(disc('redeem_reserve_collateral')), D.Equals), dc('U64Le', 8, 1n * U, D.GreaterThanOrEqualTo), dc('U64Le', 8, 1000n * U, D.LessThanOrEqualTo)] },
    { programId: TOKEN_PROGRAM_ID, accountConstraints: [pin(0, vU), pin(1, cU)], dataConstraints: [dc('U8', 0, 3, D.Equals), dc('U64Le', 1, 1000n * U, D.LessThanOrEqualTo)] }], [agentKey(agent)], 1);
{ const s0 = await snap();
  await send('V7d. agent: refresh, then ONE Squads call: gate.transfer 40 collateral tokens custody -> vault, klend redeem_reserve_collateral signed by the vault (Kamino pays the vault), the vault sends 48 USDC to custody', true,
    [cb, refresh(), viaPolicy(P, PKR.policy, [agent], [await drawNow(cK, vK, 40n * U), redeem(40n * U), sweep(48n * U)], [0, 1, 2], AL)], [agent], undefined, { cost: 'REAL Kamino redeem through the gate (agent, policy sync)' });
  await depth('Kamino redeem');
  const s1 = await snap(), dust = await bal(vU);
  check('V7e. custody gave 40 collateral tokens and got 48 USDC back; Kamino pays the redeem to the vault, so the vault keeps the rounding dust (under 1 USDC)', s0.ck - s1.ck === 40n * U && s1.cu - s0.cu === 48n * U && (await bal(vK)) === 0n && dust > 0n && dust < U, `${show(s1)}, vault dust ${fmt(dust)}`); }

console.log('--- V8 real swap: Orca Whirlpool USDC/USDT (gate draw into the Prime vault, swap signed by the vault, USDT to custody\'s gate-owned USDT account)');
const sBand = [transferC(cU, vU, 1n, 1000n), { programId: WHIRL, accountConstraints: [pin(2, pool), pin(3, vU), pin(5, cT)],
  dataConstraints: [dc('U8Slice', 0, Buffer.from('f8c69e91e17587c8', 'hex') as any, D.Equals), dc('U64Le', 8, 1n * U, D.GreaterThanOrEqualTo), dc('U64Le', 8, 1000n * U, D.LessThanOrEqualTo), dc('U64Le', 16, 1n * U, D.GreaterThanOrEqualTo), dc('U8', 40, 1, D.Equals), dc('U8', 41, 1, D.Equals)] }];
const PO = await installRule('V8. owners install rule PO (agent alone): gate draw of 1 to 1,000 USDC into the vault, and the Orca swap USDC -> USDT with the pool, input (vault) and output (custody) accounts pinned, exact-in:', P, sBand, [agentKey(agent)], 1);
costs['rule PO (gate draw + Orca swap)'] = { bytes: PO.bytes, rent: PO.rent };
{ const s0 = await snap();
  await send('V9. agent: ONE Squads call: gate.transfer 100 USDC custody -> vault, orca swap 100 USDC for at least 99 USDT signed by the vault, USDT to custody', true,
    [cb, viaPolicy(P, PO.policy, [agent], [await drawNow(cU, vU, 100n * U), orca(100n * U, 99n * U)], [0, 1], AL)], [agent], undefined, { cost: 'REAL Orca swap through the gate (agent, policy sync)' });
  await depth('Orca swap');
  const s1 = await snap();
  check('V10. custody lost 100 USDC and gained about 100.04 USDT in its gate-owned USDT account (the pool price), the vault balance did not change, the pool vaults moved by the same amounts', s0.cu - s1.cu === 100n * U && s1.ct - s0.ct >= 99n * U && s1.vu === s0.vu && s1.pa - s0.pa === 100n * U && s0.pb - s1.pb === s1.ct - s0.ct, show(s1));
  st.orcaOut = fmt(s1.ct - s0.ct); save(); }
await send('V11. the agent sets the minimum output to 0 (below the rule\'s floor of 1): refused by the rule', false, [cb, viaPolicy(P, PO.policy, [agent], [await drawNow(cU, vU, 10n * U), orca(10n * U, 0n)], [0, 1], AL)], [agent], E.num);
await send('V12. the agent aims the swap output at a stranger\'s USDT account: refused by the rule', false, [cb, viaPolicy(P, PO.policy, [agent], [await drawNow(cU, vU, 10n * U), orca(10n * U, 9n * U, { ownerB: ata(USDT, stranger.publicKey) })], [0, 1], AL)], [agent], E.acct);
await send('V13. the swap in the other direction (USDT -> USDC): refused by the rule (direction flag)', false, [cb, viaPolicy(P, PO.policy, [agent], [await drawNow(cU, vU, 10n * U), orca(10n * U, 9n * U, { aToB: false })], [0, 1], AL)], [agent], /ProgramInteraction/);
{ const s0 = await snap();
  await send('V14. the same swap by the owners at their full count signing as the agent lane (no rule): works, the gate and the venue decide', true, [cb, viaOwners(P, own2, AL, [await drawNow(cU, vU, 10n * U), orca(10n * U, 9n * U)])], own2, undefined, { cost: 'REAL Orca swap through the gate (owners as the lane, sync)' });
  check('V14b. 10 USDC became about 10 USDT at custody', (await bal(cT)) - s0.ct >= 9n * U && s0.cu - (await bal(cU)) === 10n * U); }
await send('V15. a destination that is not listed (a stranger\'s USDC account) as the draw target: refused by the gate', false, [cb, viaOwners(P, own2, AL, [await drawNow(cU, ata(USDC, stranger.publicKey), 1n * U)])], own2, E.dest);
await send('V15b. the agent lane cannot pay the recovery address (not listed): refused by the gate', false, [cb, viaOwners(P, own2, AL, [await drawNow(cU, rU, 1n * U)])], own2, E.dest);

console.log('--- V16 the whole batch waits: a rule with a Squads time lock stores the draw and the real swap, then runs both atomically');
const TIMELOCK = 6;
const PTO = await installRule(`V16. owners install rule PTO (same constraints as PO) with a ${TIMELOCK} s time lock; the owners lane may vote (cancel):`, P, sBand, [agentKey(agent), voteOnly(P.vault(OL))], 1, { timeLock: TIMELOCK });
costs['rule PTO (gate draw + Orca swap, time lock)'] = { bytes: PTO.bytes, rent: PTO.rent };
const batch = async (n: bigint, label: string, by?: number) => { const b = await store(PTO.policy, agent, vault, [draw(cU, vU, n * U, by ?? (await later(TIMELOCK + 40))), orca(n * U, (n - 1n) * U)], [0, 1], AL);
  await send(`${label}a. the agent stores the draw and the swap: create the policy transaction`, true, [cb, b.ixs[0]], [agent], undefined, { cost: 'time lock: store the Orca batch (create)' });
  await send(`${label}b. open the proposal and approve it`, true, b.ixs.slice(1), [agent], undefined, { cost: 'time lock: store the Orca batch (open and approve)' }); return b; };
const release = async (b: any) => (await propTime(PTO.policy, b.index)) + TIMELOCK;
{ const b1 = await batch(50n, 'V17'); const s0 = await snap();
  { const tx = await conn.getAccountInfo(sa.getTransactionPda({ settingsPda: PTO.policy, transactionIndex: b1.index, programId: SQUADS })[0]), pr = await conn.getAccountInfo(sa.getProposalPda({ settingsPda: PTO.policy, transactionIndex: b1.index })[0]);
    costs['time lock: stored Orca batch'] = { transactionBytes: tx?.data.length, transactionRent: tx?.lamports, proposalBytes: pr?.data.length, proposalRent: pr?.lamports }; save(); }
  check('V17c. storing moved nothing', same(s0, await snap()));
  await send('V18. run before the time lock is over: refused', false, [cb, runStored(PTO.policy, b1.index, agent.publicKey, b1.metas)], [agent], /TimeLockNotReleased/);
  await until(await release(b1));
  await send('V19. run after the wait: the gate draw and the Orca swap run as one atomic batch', true, [cb, runStored(PTO.policy, b1.index, agent.publicKey, b1.metas)], [agent], undefined, { cost: 'time lock: run the stored Orca batch (draw + swap)' });
  await depth('stored Orca batch run');
  const s1 = await snap(); check('V20. custody lost 50 USDC and gained about 50 USDT in that one run', s0.cu - s1.cu === 50n * U && s1.ct - s0.ct >= 49n * U && s1.vu === s0.vu, show(s1)); }
{ const b2 = await batch(40n, 'V21');
  await send('V22. custody alone lowers the cap to 1 USDC before the run (one signature)', true, [allowIx(g, cU, 1n * U, lowerBy.map((k) => k.publicKey))], lowerBy);
  await until(await release(b2)); const s0 = await snap();
  await send('V23. the run is refused by the token program (over the cap); the swap does not run either', false, [cb, runStored(PTO.policy, b2.index, agent.publicKey, b2.metas)], [agent], E.funds);
  check('V24. nothing moved and the stored batch is still Approved (the rule has no run window)', same(s0, await snap()) && (await statusOf(PTO.policy, b2.index)).__kind === 'Approved');
  await send('V25. the owners (2 of 3, as the owners lane) cancel the stored batch', true, [viaOwners(P, own2, OL, [ix.cancelProposal({ settingsPda: PTO.policy, transactionIndex: b2.index, signer: P.vault(OL) })])], own2, undefined, { cost: 'time lock: cancel by the owners (sync)' });
  await send('V26. run the cancelled batch: refused', false, [cb, runStored(PTO.policy, b2.index, agent.publicKey, b2.metas)], [agent], /InvalidProposalStatus|Cancelled/);
  await send('V27. the threshold sets the cap back to 10,000', true, [allowIx(g, cU, 10_000n * U, both.map((k) => k.publicKey))], both); }
{ const b3 = await batch(30n, 'V28', (await chainNow()) + TIMELOCK + 8);
  await until((await release(b3)) + 10);
  await send('V28c. a batch whose not-after has passed (the agent chose a short one): refused by the gate, so it lapses without a cancel', false, [cb, runStored(PTO.policy, b3.index, agent.publicKey, b3.metas)], [agent], E.window); }

console.log('--- V30 recovery of real venue funds: the owners lane is not bounded by the cap');
{ const cap = (await acct(cU)).delegatedAmount, r0 = await bal(rU), have = await bal(cU);
  await send('V30. custody alone suspends the cap (one signature)', true, [allowIx(g, cU, 0n, lowerBy.map((k) => k.publicKey))], lowerBy);
  await send('V30b. the agent lane is stopped by the suspended cap: a 10 USDC draw is refused', false, [cb, viaOwners(P, own2, AL, [await drawNow(cU, vU, 10n * U)])], own2, E.funds);
  await send('V30c. the owners lane recovers 500 USDC to R with the cap at 0 (and 500 is far above any cap that was left)', true, [cb, viaOwners(P, own2, OL, [transferIx({ gate: g, lane: P.vault(OL), src: cU, dst: rU, amount: 500n * U, notAfter: await later(40) })])], own2, undefined, { cost: 'REAL recovery of venue funds (owners lane)' });
  check('V30d. R gained 500 USDC', (await bal(rU)) - r0 === 500n * U && have - (await bal(cU)) === 500n * U, `cap was ${fmt(cap)}`);
  await send('V30e. the threshold restores the cap', true, [allowIx(g, cU, 10_000n * U, both.map((k) => k.publicKey))], both); }

console.log('--- V31 release of an account that held real venue funds');
{ const have = await bal(cT);
  await send('V31. the threshold releases the USDT account (the swap proceeds) to newKey', true, [releaseIx(g, cT, newKey.publicKey, both.map((k) => k.publicKey))], both);
  check('V31b. newKey owns it with the whole balance, the gate can no longer pay from it', (await acct(cT)).owner.equals(newKey.publicKey) && (await bal(cT)) === have, `${fmt(have)} USDT`);
  await send('V31c. the gate cannot draw from it: refused by the gate (not its own)', false, [cb, viaOwners(P, own2, AL, [await drawNow(cT, vU, 1n * U)])], own2, E.wrong); }

console.log('--- V40 prime-session in the path: a wallet-granted session key signs through the session PDA (one more level of CPI)');
{ NAMES[PSID.toBase58()] = 'prime-session';
  const wallet = Keypair.generate(), session = Keypair.generate();
  const [pda, bump] = PublicKey.findProgramAddressSync([Buffer.from('prime'), wallet.publicKey.toBuffer(), P.settings.toBuffer()], PSID);
  const marker = PublicKey.findProgramAddressSync([wallet.publicKey.toBuffer(), P.settings.toBuffer(), session.publicKey.toBuffer()], PSID)[0];
  const SPO = await installRule('V40. owners install rule SPO: the wallet\'s session PDA is the policy signer; same constraints as PO:', P, sBand, [{ key: pda, permissions: { mask: 7 } }], 1);
  const until_ = (await chainNow()) + 3600, text = `Prime session\nsigner: ${pda.toBase58()}\nsession key: ${session.publicKey.toBase58()}\nvalid until (unix time): ${until_}\ncluster: localnet`;
  const sig = Ed25519Program.createInstructionWithPrivateKey({ privateKey: wallet.secretKey, message: Buffer.from(text) });
  const inner = viaPolicy(P, SPO.policy, [{ publicKey: pda }], [await drawNow(cU, vU, 20n * U), orca(20n * U, 19n * U)], [0, 1], AL);
  const data = Buffer.concat([wallet.publicKey.toBuffer(), P.settings.toBuffer(), i64(until_), Buffer.from([0, bump]), inner.data]);
  const wrap = new TransactionInstruction({ programId: PSID, data, keys: [m(SYSVAR_INSTRUCTIONS_PUBKEY), m(session.publicKey, true), m(pda), m(SQUADS), m(marker), ...inner.keys.map((k) => ({ ...k, isSigner: k.pubkey.equals(pda) ? false : k.isSigner }))] });
  const s0 = await snap();
  await send('V41a. the same call as ONE legacy transaction with prime-session in front: refused, the transaction is too large', false, [sig, cb, wrap], [session], /too large/i);
  const addrs = [...new Set([...wrap.keys.map((k) => k.pubkey.toBase58()), PSID.toBase58(), SQUADS.toBase58(), WHIRL.toBase58(), GATE.toBase58(), TOKEN_PROGRAM_ID.toBase58()])].filter((a) => a !== session.publicKey.toBase58() && a !== payer.publicKey.toBase58()).map((a) => new PublicKey(a));
  const slot = await conn.getSlot('confirmed'); const [mkIx, lut] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot - 1 });
  await must('lut', [mkIx], []);
  for (let i = 0; i < addrs.length; i += 20) await must('lut', [AddressLookupTableProgram.extendLookupTable({ payer: payer.publicKey, authority: payer.publicKey, lookupTable: lut, addresses: addrs.slice(i, i + 20) })], []);
  await sleep(2500);
  const alt = (await conn.getAddressLookupTable(lut)).value!;
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: (await conn.getLatestBlockhash('confirmed')).blockhash, instructions: [sig, cb, wrap] }).compileToV0Message([alt]);
  const vtx = new VersionedTransaction(msg); vtx.sign([payer, session]);
  await lib.sendV0('V41b. the session key (no SOL, granted by the wallet) signs ONE version 0 transaction: prime-session -> Squads policy sync -> gate draw and Orca swap -> token', true, vtx, { cost: 'REAL Orca swap through prime-session and the gate (session key, lookup table)' });
  await depth('Orca swap through prime-session');
  const s1 = await snap(); check('V42. custody lost 20 USDC and gained about 20 USDT, the vault balance did not change', s0.cu - s1.cu === 20n * U && s1.ct - s0.ct >= 19n * U && s1.vu === s0.vu, show(s1)); }

const rc = finish(); process.exit(rc ? 1 : 0);
