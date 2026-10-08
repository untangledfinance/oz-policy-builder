// Unit tests for setup-checks.ts on synthetic account bytes (no validator). The live checks (token program, simulation, v0 transaction) run in gate-a4.ts.
import { describe, expect, test } from 'bun:test';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createTransferInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { MULTISIG_LEN, TOKEN_ACCOUNT_LEN, checkHandedOver, checkMultisig, checkSourceAccount, handOverIxs, legacySize, v0BestSize, parseMultisig, parseTokenAccount, txShape, weight, weightedSlots } from './setup-checks';

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
