// Unit tests for setup-checks.ts on synthetic account bytes (no validator). The live checks (token program, simulation, v0 transaction) run in gate-a4.ts.
import { describe, expect, test } from 'bun:test';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createTransferInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { FREEZE_WARNING, GATE_FIXED_LEN, MULTISIG_LEN, TOKEN_ACCOUNT_LEN, checkGate, checkHandedOver, checkMint, checkMultisig, checkSourceAccount, gateAddress, handOverIxs, legacySize, v0BestSize, parseGate, parseMultisig, parseTokenAccount, txShape, weight, weightedSlots } from './setup-checks';
import type { ExpectedGate } from './setup-checks';

const k = () => Keypair.generate().publicKey;
const codes = (xs: { code: string }[]) => xs.map((x) => x.code).sort();

function multisigBytes(m: number, slots: PublicKey[], init = 1): Uint8Array {
  const d = new Uint8Array(MULTISIG_LEN); d[0] = m; d[1] = slots.length; d[2] = init;
  slots.forEach((s, i) => d.set(s.toBytes(), 3 + 32 * i));
  return d;
}
function tokenBytes(o: { mint?: PublicKey; owner?: PublicKey; closer?: PublicKey | null; delegate?: PublicKey | null; native?: boolean; state?: number; extra?: number; delegated?: bigint }): Uint8Array {
  const d = new Uint8Array(TOKEN_ACCOUNT_LEN + (o.extra ?? 0)); const v = new DataView(d.buffer);
  d.set((o.mint ?? k()).toBytes(), 0); d.set((o.owner ?? k()).toBytes(), 32); d[108] = o.state ?? 1;
  if (o.delegate) { v.setUint32(72, 1, true); d.set(o.delegate.toBytes(), 76); }
  if (o.native) v.setUint32(109, 1, true);
  v.setBigUint64(121, o.delegated ?? 0n, true);
  if (o.closer) { v.setUint32(129, 1, true); d.set(o.closer.toBytes(), 133); }
  return d;
}

describe('multisig', () => {
  const custody = k(), backup = k(), trustee = k();
  test('parse reads m, n, the flag and only the first n slots', () => {
    const ms = parseMultisig(multisigBytes(2, [custody, trustee]));
    expect(ms.m).toBe(2); expect(ms.n).toBe(2); expect(ms.initialized).toBe(true); expect(ms.slots.map(String)).toEqual([custody, trustee].map(String));
  });
  test('parse refuses a wrong length and n above 11', () => {
    expect(() => parseMultisig(new Uint8Array(100))).toThrow();
    const d = multisigBytes(2, [custody, trustee]); d[1] = 12;
    expect(() => parseMultisig(d)).toThrow();
  });
  test('2-of-2 custody + trustee is clean', () => {
    expect(checkMultisig(parseMultisig(multisigBytes(2, [custody, trustee])), { custody: [custody], trustee })).toEqual([]);
  });
  test('m greater than n is flagged (the token program accepts it)', () => {
    expect(codes(checkMultisig(parseMultisig(multisigBytes(3, [custody, trustee])), { custody: [custody], trustee }))).toContain('m-greater-than-n');
  });
  test('uninitialised multisig is flagged and stops there', () => {
    expect(codes(checkMultisig(parseMultisig(multisigBytes(2, [custody, trustee], 0)), { custody: [custody], trustee }))).toEqual(['multisig-uninitialized']);
  });
  test('2-of-3 with two custody keys gives custody the threshold', () => {
    expect(codes(checkMultisig(parseMultisig(multisigBytes(2, [custody, backup, trustee])), { custody: [custody, backup], trustee }))).toEqual(['custody-reaches-m']);
  });
  test('m = 1 is flagged: one key alone releases', () => {
    expect(codes(checkMultisig(parseMultisig(multisigBytes(1, [custody, trustee])), { custody: [custody], trustee }))).toContain('m-below-two');
  });
  test('a slot nobody on the setup controls is flagged', () => {
    const stray = k();
    expect(codes(checkMultisig(parseMultisig(multisigBytes(2, [custody, stray])), { custody: [custody], trustee }))).toContain('unknown-signer');
  });
  test('a trustee that reaches m alone is flagged', () => {
    expect(codes(checkMultisig(parseMultisig(multisigBytes(2, [custody, trustee, trustee])), { custody: [custody], trustee }))).toContain('trustee-reaches-m');
  });
  test('weight counts one per slot, so a duplicate trustee slot has weight 2', () => {
    const ms = parseMultisig(multisigBytes(3, [custody, backup, trustee, trustee]));
    expect(weight(ms, [trustee])).toBe(2); expect(weight(ms, [custody, backup])).toBe(2); expect(weight(ms, [custody, trustee])).toBe(3); expect(weight(ms, [custody, custody])).toBe(1);
  });
  test('weightedSlots: 2-of-2 has no duplicate; m = 3 with a backup duplicates the trustee and passes checkMultisig', () => {
    expect(weightedSlots([custody], trustee, 2).map(String)).toEqual([custody, trustee].map(String));
    const slots = weightedSlots([custody, backup], trustee, 3);
    expect(slots.map(String)).toEqual([custody, backup, trustee, trustee].map(String));
    expect(checkMultisig(parseMultisig(multisigBytes(3, slots)), { custody: [custody, backup], trustee })).toEqual([]);
  });
  test('weightedSlots refuses a layout where custody alone reaches m, m below 2, a shared key, and more than 11 slots', () => {
    expect(() => weightedSlots([custody, backup], trustee, 2)).toThrow();
    expect(() => weightedSlots([custody], trustee, 1)).toThrow();
    expect(() => weightedSlots([custody, custody], trustee, 3)).toThrow();
    expect(() => weightedSlots([custody], custody, 2)).toThrow();
    expect(() => weightedSlots([custody], trustee, 12)).toThrow();
  });
});

describe('source account', () => {
  const gate = k();
  test('a dedicated account of 165 bytes is clean; an associated account is flagged', () => {
    const owner = k(), mint = k(), addr = k();
    expect(checkSourceAccount(addr, tokenBytes({ mint, owner }), TOKEN_PROGRAM_ID)).toEqual([]);
    const ata = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);
    expect(codes(checkSourceAccount(ata, tokenBytes({ mint, owner }), TOKEN_PROGRAM_ID))).toEqual(['associated-account']);
    const ata22 = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
    expect(codes(checkSourceAccount(ata22, tokenBytes({ mint, owner, extra: 5 }), TOKEN_2022_PROGRAM_ID))).toEqual(['associated-account', 'extensions']);
  });
  test('an account with extensions or a frozen state is flagged; other programs are refused', () => {
    expect(codes(checkSourceAccount(k(), tokenBytes({ extra: 10 }), TOKEN_2022_PROGRAM_ID))).toEqual(['extensions']);
    expect(codes(checkSourceAccount(k(), tokenBytes({ state: 2 }), TOKEN_PROGRAM_ID))).toEqual(['frozen']);
    expect(codes(checkSourceAccount(k(), tokenBytes({}), SystemProgram.programId))).toEqual(['not-a-token-program']);
  });
  test('parseTokenAccount reads delegate, delegated amount and close authority; it refuses short or uninitialised data', () => {
    const closer = k(), del = k();
    const a = parseTokenAccount(tokenBytes({ closer, delegate: del, delegated: 7n }));
    expect(a.closeAuthority?.equals(closer)).toBe(true); expect(a.delegate?.equals(del)).toBe(true); expect(a.delegatedAmount).toBe(7n);
    expect(() => parseTokenAccount(new Uint8Array(100))).toThrow();
    expect(() => parseTokenAccount(tokenBytes({ state: 0 }))).toThrow();
  });
  test('handOverIxs: close authority first, then owner, both to the gate, signed by the closer', () => {
    const acct = k(), closer = k();
    const [first, second] = handOverIxs(acct, closer, gate);
    expect(first.data[0]).toBe(6); expect(first.data[1]).toBe(3);   // SetAuthority, CloseAccount
    expect(second.data[0]).toBe(6); expect(second.data[1]).toBe(2); // SetAuthority, AccountOwner
    for (const x of [first, second]) { expect(new PublicKey(x.data.subarray(3, 35)).equals(gate)).toBe(true); expect(x.keys[1].pubkey.equals(closer)).toBe(true); expect(x.keys[1].isSigner).toBe(true); }
  });
  test('read-back: owner and close authority must both be the gate; wrapped SOL may show none', () => {
    expect(checkHandedOver(tokenBytes({ owner: gate, closer: gate }), gate)).toEqual([]);
    expect(codes(checkHandedOver(tokenBytes({ owner: gate, closer: k() }), gate))).toEqual(['close-authority-not-gate']);
    expect(codes(checkHandedOver(tokenBytes({ owner: gate }), gate))).toEqual(['close-authority-not-gate']);
    expect(codes(checkHandedOver(tokenBytes({ owner: k(), closer: gate }), gate))).toEqual(['owner-not-gate']);
    expect(checkHandedOver(tokenBytes({ owner: gate, native: true }), gate)).toEqual([]);
    expect(codes(checkHandedOver(tokenBytes({ owner: gate, native: true, closer: k() }), gate))).toEqual(['close-authority-not-gate']);
    expect(checkHandedOver(tokenBytes({ owner: gate, native: true, closer: gate }), gate)).toEqual([]);
    expect(codes(checkHandedOver(tokenBytes({ owner: gate, closer: gate, delegate: k(), delegated: 5n }), gate))).toEqual(['stale-delegate']);
    expect(codes(checkHandedOver(tokenBytes({ owner: gate, closer: gate, extra: 8 }), gate))).toEqual(['extensions']);
  });
});

describe('transaction shape', () => {
  const signers = Array.from({ length: 11 }, k), acct = k(), dst = k(), ms = k();
  const transferBy = (n: number): TransactionInstruction => createTransferInstruction(acct, dst, ms, 1n, signers.slice(0, n));
  test('10 multisig signers fit one legacy transaction when one of them pays the fee; 11 need a version 0 transaction and a lookup table', () => {
    expect(txShape([transferBy(10)], signers[0])).toBe('legacy');
    expect(legacySize([transferBy(11)], signers[0])).toBeGreaterThan(1232);
    expect(txShape([transferBy(11)], signers[0])).toBe('v0+lookup-table');
    expect(v0BestSize([transferBy(11)], signers[0])).toBeLessThanOrEqual(1232);
  });
  test('a separate relayer fee payer adds a signature: 10 signers need version 0 and 11 do not fit at all', () => {
    expect(txShape([transferBy(2)], k())).toBe('legacy');
    expect(txShape([transferBy(10)], k())).toBe('v0+lookup-table');
    expect(txShape([transferBy(11)], k())).toBe('too-large');
  });
});

// ── mint: what the gate can hold ────────────────────────────────────────────────────────────────
function mintBytes(o: { freeze?: PublicKey; exts?: [number, Uint8Array][]; marker?: number; init?: number } = {}): Uint8Array {
  const body = new Uint8Array(82); const v = new DataView(body.buffer);
  v.setUint32(0, 1, true); body.set(k().toBytes(), 4); body[44] = 6; body[45] = o.init ?? 1;
  if (o.freeze) { v.setUint32(46, 1, true); body.set(o.freeze.toBytes(), 50); }
  if (!o.exts) return body;
  const tlv = o.exts.map(([t, val]) => { const e = new Uint8Array(4 + val.length); new DataView(e.buffer).setUint16(0, t, true); new DataView(e.buffer).setUint16(2, val.length, true); e.set(val, 4); return e; });
  const out = new Uint8Array(166 + tlv.reduce((n, e) => n + e.length, 0)); out.set(body, 0); out[165] = o.marker ?? 1;
  let at = 166; for (const e of tlv) { out.set(e, at); at += e.length; }
  return out;
}
const ext = (type: number, len: number, first = 0): [number, Uint8Array] => { const b = new Uint8Array(len); if (len) b[0] = first; return [type, b]; };
const mintCodes = (r: { refuse: { code: string }[] }) => codes(r.refuse);
const T22 = TOKEN_2022_PROGRAM_ID, T = TOKEN_PROGRAM_ID;

describe('mint', () => {
  test('a classic mint with no freeze authority is clean and needs no warning', () => {
    const r = checkMint({ owner: T, data: mintBytes() });
    expect(r.program).toBe('token'); expect(r.refuse).toEqual([]); expect(r.warn).toEqual([]);
  });
  test('a freezable mint (USDC, USDT) is allowed but warns: the issuer can freeze, and recovery and release are refused while frozen', () => {
    const fa = k(), r = checkMint({ owner: T, data: mintBytes({ freeze: fa }) });
    expect(r.refuse).toEqual([]); expect(codes(r.warn)).toEqual(['freeze-authority']);
    expect(r.warn[0].message).toContain(FREEZE_WARNING); expect(r.warn[0].message).toContain(fa.toBase58());
    expect(FREEZE_WARNING).toBe('the issuer can freeze this account; while frozen, recovery and release are refused');
  });
  test('a Token-2022 mint with no extension is allowed with a warning that says to prefer the classic Token program', () => {
    const r = checkMint({ owner: T22, data: mintBytes() });
    expect(r.program).toBe('token-2022'); expect(r.refuse).toEqual([]); expect(codes(r.warn)).toEqual(['token-2022']); expect(r.warn[0].message).toContain('prefer');
  });
  test('a permanent delegate is refused', () => {
    expect(mintCodes(checkMint({ owner: T22, data: mintBytes({ exts: [ext(12, 32, 7)] }) }))).toEqual(['permanent-delegate']);
  });
  test('a transfer hook, a transfer fee, confidential transfer and non-transferable are each refused', () => {
    expect(mintCodes(checkMint({ owner: T22, data: mintBytes({ exts: [ext(14, 64, 1)] }) }))).toEqual(['transfer-hook']);
    expect(mintCodes(checkMint({ owner: T22, data: mintBytes({ exts: [ext(1, 108, 1)] }) }))).toEqual(['transfer-fee']);
    expect(mintCodes(checkMint({ owner: T22, data: mintBytes({ exts: [ext(4, 65, 1)] }) }))).toEqual(['confidential-transfer']);
    expect(mintCodes(checkMint({ owner: T22, data: mintBytes({ exts: [ext(9, 0)] }) }))).toEqual(['non-transferable']);
    expect(mintCodes(checkMint({ owner: T22, data: mintBytes({ exts: [ext(16, 64, 1)] }) }))).toEqual(['confidential-transfer-fee']);
    expect(mintCodes(checkMint({ owner: T22, data: mintBytes({ exts: [ext(24, 64, 1)] }) }))).toEqual(['confidential-mint-burn']);
  });
  test('a zero transfer fee or an unset hook is refused too: the authority can change them later', () => {
    expect(mintCodes(checkMint({ owner: T22, data: mintBytes({ exts: [ext(1, 108, 0), ext(14, 64, 0)] }) }))).toEqual(['transfer-fee', 'transfer-hook']);
  });
  test('default account state: frozen is refused, initialised is allowed (the freeze authority warning still shows)', () => {
    expect(mintCodes(checkMint({ owner: T22, data: mintBytes({ freeze: k(), exts: [ext(6, 1, 2)] }) }))).toEqual(['default-account-state-frozen']);
    const ok = checkMint({ owner: T22, data: mintBytes({ freeze: k(), exts: [ext(6, 1, 1)] }) });
    expect(ok.refuse).toEqual([]); expect(codes(ok.warn)).toEqual(['freeze-authority', 'token-2022']);
    expect(mintCodes(checkMint({ owner: T22, data: mintBytes({ exts: [ext(6, 1, 0)] }) }))).toEqual(['malformed-mint']);
    expect(mintCodes(checkMint({ owner: T22, data: mintBytes({ exts: [ext(6, 2, 2)] }) }))).toEqual(['malformed-mint']);
  });
  test('an extension the check does not know is refused (fail closed), including a type above the known range and an account-only type', () => {
    expect(mintCodes(checkMint({ owner: T22, data: mintBytes({ exts: [ext(9999, 8)] }) }))).toEqual(['unknown-extension']);
    expect(mintCodes(checkMint({ owner: T22, data: mintBytes({ exts: [ext(7, 0)] }) }))).toEqual(['unknown-extension']);
    expect(mintCodes(checkMint({ owner: T22, data: mintBytes({ exts: [ext(28, 32)] }) }))).toEqual(['unknown-extension']);
  });
  test('an unknown extension next to a benign one is still refused; several refusals all show', () => {
    expect(mintCodes(checkMint({ owner: T22, data: mintBytes({ exts: [ext(18, 64), ext(9999, 4)] }) }))).toEqual(['unknown-extension']);
    expect(mintCodes(checkMint({ owner: T22, data: mintBytes({ exts: [ext(12, 32, 1), ext(14, 64, 1), ext(77, 1)] }) }))).toEqual(['permanent-delegate', 'transfer-hook', 'unknown-extension']);
  });
  test('benign extensions (metadata pointer, close authority, interest-bearing) are allowed; a pausable mint warns', () => {
    const r = checkMint({ owner: T22, data: mintBytes({ exts: [ext(18, 64, 1), ext(3, 32, 1), ext(10, 52, 1), ext(19, 80), ext(25, 56), ext(20, 64), ext(21, 80), ext(22, 64), ext(23, 72)] }) });
    expect(r.refuse).toEqual([]); expect(codes(r.warn)).toEqual(['token-2022']);
    const p = checkMint({ owner: T22, data: mintBytes({ exts: [ext(26, 33, 1)] }) });
    expect(p.refuse).toEqual([]); expect(codes(p.warn)).toEqual(['pausable', 'token-2022']);
  });
  test('a benign extension with the wrong length, a cut-off header or body, a bad marker and non-zero padding are all refused as malformed', () => {
    expect(mintCodes(checkMint({ owner: T22, data: mintBytes({ exts: [ext(18, 10)] }) }))).toEqual(['malformed-mint']);
    expect(mintCodes(checkMint({ owner: T22, data: mintBytes({ exts: [ext(19, 20)] }) }))).toEqual(['malformed-mint']);
    expect(mintCodes(checkMint({ owner: T22, data: mintBytes({ exts: [ext(26, 5)] }) }))).toEqual(['malformed-mint']);
    const cutBody = mintBytes({ exts: [ext(12, 32, 7)] }).slice(0, 166 + 4 + 10);
    expect(mintCodes(checkMint({ owner: T22, data: cutBody }))).toEqual(['malformed-mint']);
    const cutHead = mintBytes({ exts: [ext(12, 32, 7)] }).slice(0, 166 + 2);
    expect(mintCodes(checkMint({ owner: T22, data: cutHead }))).toEqual(['malformed-mint']);
    expect(mintCodes(checkMint({ owner: T22, data: mintBytes({ exts: [ext(12, 32, 7)], marker: 2 }) }))).toEqual(['malformed-mint']);
    const pad = mintBytes({ exts: [ext(18, 64)] }), padded = new Uint8Array(pad.length + 8); padded.set(pad);
    expect(checkMint({ owner: T22, data: padded }).refuse).toEqual([]);
    padded[padded.length - 1] = 1; expect(mintCodes(checkMint({ owner: T22, data: padded }))).toEqual(['malformed-mint']);
  });
  test('a mint between 83 and 165 bytes, an uninitialised mint, a bad flag and a classic mint with extra bytes are refused', () => {
    expect(mintCodes(checkMint({ owner: T22, data: new Uint8Array(120) }))).toEqual(['malformed-mint']);
    expect(mintCodes(checkMint({ owner: T22, data: mintBytes({ init: 0 }) }))).toEqual(['malformed-mint']);
    expect(mintCodes(checkMint({ owner: T22, data: new Uint8Array(40) }))).toEqual(['malformed-mint']);
    const badFlag = mintBytes(); new DataView(badFlag.buffer).setUint32(46, 2, true);
    expect(mintCodes(checkMint({ owner: T, data: badFlag }))).toEqual(['malformed-mint']);
    const badAuth = mintBytes(); new DataView(badAuth.buffer).setUint32(0, 2, true);
    expect(mintCodes(checkMint({ owner: T, data: badAuth }))).toEqual(['malformed-mint']);
    expect(mintCodes(checkMint({ owner: T, data: mintBytes({ exts: [ext(18, 64)] }) }))).toEqual(['malformed-mint']);
  });
  test('a mint owned by any other program is refused', () => {
    const r = checkMint({ owner: SystemProgram.programId, data: mintBytes() });
    expect(r.program).toBeNull(); expect(mintCodes(r)).toEqual(['not-a-token-program']);
  });
});

// ── gate: what the account says against what custody and the owners expect ──────────────────────
const GP = k();
function gateFixture(o: Partial<ExpectedGate> = {}) {
  const want: ExpectedGate = {
    program: GP, multisig: k(), settings: k(), agentLane: k(), ownersLane: k(), recovery: k(), until: 1_800_000_000n, window: 60, seed: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
    destinations: [k(), k()], custody: [k(), k()], ...o,
  };
  const [address, bump] = gateAddress(want.program, want.multisig, want.settings, want.seed);
  const data = new Uint8Array(GATE_FIXED_LEN + 32 * want.destinations.length), v = new DataView(data.buffer);
  data.set(want.multisig.toBytes(), 0); data.set(want.settings.toBytes(), 32); data.set(want.agentLane.toBytes(), 64); data.set(want.ownersLane.toBytes(), 96); data.set(want.recovery.toBytes(), 128);
  v.setBigInt64(160, BigInt(want.until), true); v.setUint32(168, want.window, true); data.set(want.seed, 172); data[180] = bump;
  want.destinations.forEach((d, i) => data.set(d.toBytes(), GATE_FIXED_LEN + 32 * i));
  return { want, address, data };
}

describe('gate read-back', () => {
  test('parseGate reads every field of the 181-byte layout and the destinations after it', () => {
    const { want, data } = gateFixture(), g = parseGate(data);
    expect(g.multisig.equals(want.multisig)).toBe(true); expect(g.settings.equals(want.settings)).toBe(true); expect(g.agentLane.equals(want.agentLane)).toBe(true); expect(g.ownersLane.equals(want.ownersLane)).toBe(true);
    expect(g.recovery.equals(want.recovery)).toBe(true); expect(g.until).toBe(1_800_000_000n); expect(g.window).toBe(60); expect(Array.from(g.seed)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(g.destinations.map(String)).toEqual(want.destinations.map(String)); expect(data.length).toBe(181 + 64);
  });
  test('parseGate refuses a short account and a destination list that is not whole 32-byte entries', () => {
    expect(() => parseGate(new Uint8Array(180))).toThrow(); expect(() => parseGate(new Uint8Array(181 + 31))).toThrow(); expect(parseGate(new Uint8Array(181)).destinations).toEqual([]);
  });
  test('the gate address is derived from the seeds "gate", multisig, settings, seed under the gate program', () => {
    const { want, address } = gateFixture(), [direct] = PublicKey.findProgramAddressSync([Buffer.from('gate'), want.multisig.toBuffer(), want.settings.toBuffer(), want.seed], GP);
    expect(address.equals(direct)).toBe(true);
    expect(gateAddress(GP, want.settings, want.multisig, want.seed)[0].equals(direct)).toBe(false);
  });
  test('a gate that matches what was expected passes', () => {
    const { want, address, data } = gateFixture();
    expect(checkGate({ address, owner: GP, data }, want)).toEqual([]);
  });
  test('a gate with a different recovery address is refused', () => {
    const { want, address, data } = gateFixture(), attacker = k();
    const r = checkGate({ address, owner: GP, data: gateFixture({ ...want, recovery: attacker, destinations: want.destinations }).data }, want);
    expect(codes(r)).toEqual(['gate-recovery']); expect(r[0].message).toContain(attacker.toBase58());
    expect(checkGate({ address, owner: GP, data }, want)).toEqual([]);
  });
  test('each fixed field that differs is refused on its own code', () => {
    const base = gateFixture(), alt = (o: Partial<ExpectedGate>) => gateFixture({ ...base.want, ...o }).data;
    const cases: [string, Partial<ExpectedGate>][] = [
      ['gate-multisig', { multisig: k() }], ['gate-settings', { settings: k() }], ['gate-agent-lane', { agentLane: k() }], ['gate-owners-lane', { ownersLane: k() }],
      ['gate-until', { until: 1_900_000_000n }], ['gate-window', { window: 3600 }],
    ];
    for (const [code, o] of cases) {
      const r = codes(checkGate({ address: base.address, owner: GP, data: alt(o) }, base.want));
      // multisig, settings and seed also name the gate address, so a different value shows the address and the bump as well
      expect(r).toContain(code);
    }
    expect(codes(checkGate({ address: base.address, owner: GP, data: alt({ until: 1_900_000_000n }) }, base.want))).toEqual(['gate-until']);
    expect(codes(checkGate({ address: base.address, owner: GP, data: alt({ window: 3600 }) }, base.want))).toEqual(['gate-window']);
    expect(codes(checkGate({ address: base.address, owner: GP, data: alt({ agentLane: k() }) }, base.want))).toEqual(['gate-agent-lane']);
    expect(codes(checkGate({ address: base.address, owner: GP, data: alt({ ownersLane: k() }) }, base.want))).toEqual(['gate-owners-lane']);
  });
  test('a different seed in the data is refused (the bytes were written for another address)', () => {
    const base = gateFixture(), data = base.data.slice(); data[175] ^= 1;
    expect(codes(checkGate({ address: base.address, owner: GP, data }, base.want))).toEqual(['gate-seed']);
  });
  test('a wrong stored bump is refused: the gate could not sign for its own accounts', () => {
    const base = gateFixture(), data = base.data.slice(); data[180] ^= 1;
    expect(codes(checkGate({ address: base.address, owner: GP, data }, base.want))).toEqual(['gate-bump']);
  });
  test('the destination list must match exactly: an extra entry, a missing one and a swapped one are refused', () => {
    const base = gateFixture(), d = base.want.destinations;
    for (const dests of [[...d, k()], [d[0]], [d[0], k()], [d[1], d[0]], []]) {
      expect(codes(checkGate({ address: base.address, owner: GP, data: gateFixture({ ...base.want, destinations: dests }).data }, base.want))).toEqual(['gate-destinations']);
    }
  });
  test('an account at another address, owned by another program, or of the wrong size is refused', () => {
    const base = gateFixture();
    expect(codes(checkGate({ address: k(), owner: GP, data: base.data }, base.want))).toEqual(['gate-address']);
    expect(codes(checkGate({ address: base.address, owner: SystemProgram.programId, data: base.data }, base.want))).toEqual(['gate-owner']);
    expect(codes(checkGate({ address: base.address, owner: GP, data: base.data.slice(0, 200) }, base.want))).toEqual(['gate-malformed']);
  });
  test('a recovery address that is empty, custody\'s own, the multisig itself or a listed destination is refused', () => {
    const base = gateFixture();
    const run = (recovery: PublicKey, dests = base.want.destinations) => {
      const w = { ...base.want, recovery, destinations: dests }, f = gateFixture(w); return codes(checkGate({ address: f.address, owner: GP, data: f.data }, w));
    };
    expect(run(PublicKey.default)).toEqual(['recovery-unset']);
    expect(run(base.want.custody[0])).toEqual(['recovery-is-custody']);
    expect(run(base.want.multisig)).toEqual(['recovery-is-custody']);
    expect(run(base.want.destinations[1])).toEqual(['recovery-is-destination']);
  });
});
