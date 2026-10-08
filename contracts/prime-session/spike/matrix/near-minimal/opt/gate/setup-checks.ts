// The checks the Prime app makes around custody's setup of a gate-owned token account. Each function reads bytes or builds instructions; none holds a key or sends a transaction.
//   1. custody's multisig: m <= n, every slot is a key the setup knows, a zero-amount test signature proves the intended signers reach m and custody's keys alone do not
//   2. the trustee is mandatory: no set of custody's keys reaches m (duplicate trustee slots give the trustee weight)
//   3. the account that goes under the gate: a dedicated (non-associated) account of exactly 165 bytes, so no extension (CPI guard, memo, fee, hook) can block the gate's token calls
//   4. the hand-over: close authority first, then owner, both to the gate PDA; read the account back and confirm owner and close authority are the gate (close authority none for wrapped SOL)
//   5. an 11-signer multisig needs a version 0 transaction and a lookup table
import {
  AddressLookupTableProgram, AddressLookupTableAccount, Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { AuthorityType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createSetAuthorityInstruction, createTransferInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';

export const MULTISIG_LEN = 355, MAX_SIGNERS = 11, TX_LIMIT = 1232, TOKEN_ACCOUNT_LEN = 165;
export type Issue = { code: string; message: string };
export type Multisig = { m: number; n: number; initialized: boolean; slots: PublicKey[] };

/** The SPL multisig layout: m, n, initialized flag, 11 signer slots of 32 bytes. Only the first n slots count. */
export function parseMultisig(data: Uint8Array): Multisig {
  if (data.length !== MULTISIG_LEN) throw new Error(`multisig account is ${MULTISIG_LEN} bytes, got ${data.length}`);
  const [m, n, init] = data;
  if (n > MAX_SIGNERS) throw new Error(`n = ${n} exceeds ${MAX_SIGNERS} slots`);
  const slots = Array.from({ length: n }, (_, i) => new PublicKey(data.subarray(3 + 32 * i, 35 + 32 * i)));
  return { m, n, initialized: init === 1, slots };
}

/** What the token program counts: every slot held by a key that signs, so a key listed k times carries weight k. */
export function weight(ms: Multisig, signing: PublicKey[]): number {
  const set = new Set(signing.map((k) => k.toBase58()));
  return ms.slots.filter((s) => set.has(s.toBase58())).length;
}

/**
 * Issues with the multisig that is custody's identity. `custody` are the keys custody controls (its main key and any backup), `trustee` is the second party.
 * The token program accepts m > n (no set of signers can ever satisfy it: no release, no cap increase) and a 2-of-3 whose two custody keys alone reach 2.
 */
export function checkMultisig(ms: Multisig, who: { custody: PublicKey[]; trustee: PublicKey }): Issue[] {
  if (!ms.initialized) return [{ code: 'multisig-uninitialized', message: 'the multisig account is not initialised' }];
  const out: Issue[] = [];
  if (ms.m < 2) out.push({ code: 'm-below-two', message: `m = ${ms.m}: one key alone releases the account and raises the cap` });
  if (ms.m > ms.n) out.push({ code: 'm-greater-than-n', message: `m = ${ms.m} exceeds n = ${ms.n}: no set of signers can ever release the account or raise the cap` });
  const known = new Set([...who.custody, who.trustee].map((k) => k.toBase58()));
  for (const s of ms.slots) if (!known.has(s.toBase58())) out.push({ code: 'unknown-signer', message: `slot ${s.toBase58()} is not a key custody or the trustee controls` });
  if (weight(ms, who.custody) >= ms.m) out.push({ code: 'custody-reaches-m', message: `custody's keys alone hold weight ${weight(ms, who.custody)} of the ${ms.m} needed: the trustee is not mandatory` });
  if (weight(ms, [who.trustee]) >= ms.m) out.push({ code: 'trustee-reaches-m', message: `the trustee alone holds weight ${weight(ms, [who.trustee])} of the ${ms.m} needed` });
  return out;
}

/**
 * The slot list that keeps the trustee mandatory while any one custody key plus the trustee still reaches m: custody's keys once each, the trustee m - 1 times.
 * [custody, trustee] for 2-of-2; [custody, backup, trustee, trustee] for m = 3. Throws when custody's keys alone would reach m or the list exceeds 11 slots.
 */
export function weightedSlots(custody: PublicKey[], trustee: PublicKey, m: number): PublicKey[] {
  if (!Number.isInteger(m) || m < 2) throw new Error('m must be an integer of at least 2: with m = 1 any single key moves funds');
  const distinct = new Set(custody.map((k) => k.toBase58()));
  if (distinct.size !== custody.length || distinct.has(trustee.toBase58())) throw new Error('custody keys must be distinct and differ from the trustee');
  if (custody.length < 1) throw new Error('custody needs at least one key');
  if (custody.length >= m) throw new Error(`custody's ${custody.length} keys would reach m = ${m} without the trustee`);
  const slots = [...custody, ...Array.from({ length: m - 1 }, () => trustee)];
  if (slots.length > MAX_SIGNERS) throw new Error(`${slots.length} slots exceed the limit of ${MAX_SIGNERS}`);
  return slots;
}

/** A zero-amount transfer from a multisig-owned token account to itself. It moves nothing and passes only if `signers` authorise the multisig. */
export function testSignatureIx(account: PublicKey, ms: PublicKey, signers: PublicKey[], program: PublicKey = TOKEN_PROGRAM_ID): TransactionInstruction {
  return createTransferInstruction(account, account, ms, 0n, signers, program);
}

/** Simulates the test signature signed by `signers` (fee paid by `feePayer`) with signature verification on. Returns whether the token program accepted it. */
export async function simulateTestSignature(conn: Connection, o: { account: PublicKey; ms: PublicKey; program?: PublicKey; signers: Keypair[]; feePayer: Keypair }): Promise<{ ok: boolean; error: string }> {
  const ix = testSignatureIx(o.account, o.ms, o.signers.map((k) => k.publicKey), o.program);
  const msg = new TransactionMessage({ payerKey: o.feePayer.publicKey, recentBlockhash: (await conn.getLatestBlockhash('confirmed')).blockhash, instructions: [ix] }).compileToV0Message();
  const t = new VersionedTransaction(msg); t.sign([o.feePayer, ...o.signers.filter((k) => !k.publicKey.equals(o.feePayer.publicKey))]);
  const r = await conn.simulateTransaction(t, { sigVerify: true });
  return { ok: r.value.err === null, error: r.value.err === null ? '' : `${JSON.stringify(r.value.err)} ${(r.value.logs ?? []).filter((l) => /failed|error/i.test(l)).join(' | ')}`.trim() };
}

const u32 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset + o, 4).getUint32(0, true);
const pk = (d: Uint8Array, o: number) => new PublicKey(d.subarray(o, o + 32));
export type TokenAccount = { mint: PublicKey; owner: PublicKey; delegate: PublicKey | null; delegatedAmount: bigint; frozen: boolean; native: boolean; closeAuthority: PublicKey | null; length: number };

/** The base token account layout shared by Token and Token-2022: mint 0, owner 32, amount 64, delegate 72, state 108, is_native 109, delegated amount 121, close authority 129. */
export function parseTokenAccount(data: Uint8Array): TokenAccount {
  if (data.length < TOKEN_ACCOUNT_LEN) throw new Error(`not a token account: ${data.length} bytes`);
  if (data[108] === 0) throw new Error('token account is not initialised');
  return {
    mint: pk(data, 0), owner: pk(data, 32), delegate: u32(data, 72) === 1 ? pk(data, 76) : null, frozen: data[108] === 2, native: u32(data, 109) === 1,
    delegatedAmount: new DataView(data.buffer, data.byteOffset + 121, 8).getBigUint64(0, true), closeAuthority: u32(data, 129) === 1 ? pk(data, 133) : null, length: data.length,
  };
}

/**
 * Issues with a token account before custody hands it to the gate. The account must be a dedicated one (not the associated account of its owner), exactly 165 bytes with no extension:
 * an extension such as the Token-2022 CPI guard would block the gate's own transfer, approve and set-authority calls and freeze the funds. A fee or hook mint adds extensions on its own.
 */
export function checkSourceAccount(address: PublicKey, data: Uint8Array, program: PublicKey): Issue[] {
  if (!program.equals(TOKEN_PROGRAM_ID) && !program.equals(TOKEN_2022_PROGRAM_ID)) return [{ code: 'not-a-token-program', message: 'only Token and Token-2022 are supported' }];
  const a = parseTokenAccount(data), out: Issue[] = [];
  if (getAssociatedTokenAddressSync(a.mint, a.owner, true, program).equals(address)) out.push({ code: 'associated-account', message: 'an associated account names its owner in its address and a Token-2022 one has an immutable owner: move the funds into a dedicated account' });
  if (a.length !== TOKEN_ACCOUNT_LEN) out.push({ code: 'extensions', message: `${a.length} bytes: the account carries extensions (CPI guard, memo, transfer fee or hook) that can block the gate's token calls` });
  if (a.frozen) out.push({ code: 'frozen', message: 'the account is frozen' });
  return out;
}

/** The two SetAuthority calls that hand a dedicated account to the gate PDA: close authority first, then owner. `closer` is the current close authority, or the owner when none is set; it signs both. */
export function handOverIxs(account: PublicKey, closer: PublicKey, gate: PublicKey, program: PublicKey = TOKEN_PROGRAM_ID): TransactionInstruction[] {
  return [AuthorityType.CloseAccount, AuthorityType.AccountOwner].map((t) => createSetAuthorityInstruction(account, closer, t, gate, [], program));
}

/**
 * Reads an account back after the hand-over: the owner must be the gate and the close authority the gate (none for wrapped SOL, where Token clears it on the owner change),
 * with no stale delegate. Run it before the multisig raises the cap: the gate refuses a cap while another party holds the close authority.
 */
export function checkHandedOver(data: Uint8Array, gate: PublicKey): Issue[] {
  const a = parseTokenAccount(data), out: Issue[] = [];
  if (!a.owner.equals(gate)) out.push({ code: 'owner-not-gate', message: `owner is ${a.owner.toBase58()}, not the gate` });
  const closeOk = a.native ? a.closeAuthority === null || a.closeAuthority.equals(gate) : a.closeAuthority?.equals(gate) === true;
  if (!closeOk) out.push({ code: 'close-authority-not-gate', message: `close authority is ${a.closeAuthority?.toBase58() ?? 'none'}: custody could close the emptied account and reopen the address as its own` });
  if (a.delegate !== null || a.delegatedAmount !== 0n) out.push({ code: 'stale-delegate', message: `a delegate ${a.delegate?.toBase58()} still holds ${a.delegatedAmount}` });
  if (a.length !== TOKEN_ACCOUNT_LEN) out.push({ code: 'extensions', message: `${a.length} bytes: the account carries extensions` });
  return out;
}

/** Bytes of `ixs` as one legacy transaction: signature count, signatures, message. */
export function legacySize(ixs: TransactionInstruction[], feePayer: PublicKey): number {
  const msg = new TransactionMessage({ payerKey: feePayer, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToLegacyMessage();
  return 1 + 64 * msg.header.numRequiredSignatures + msg.serialize().length;
}
/** Bytes of `ixs` as a version 0 transaction whose lookup table holds every account key (the best case a table can give: signers and program ids stay static). */
export function v0BestSize(ixs: TransactionInstruction[], feePayer: PublicKey): number {
  const addresses = [...new Map(ixs.flatMap((i) => i.keys.map((k) => [k.pubkey.toBase58(), k.pubkey] as const))).values()];   // the compiler keeps signers and program ids static
  const table = new AddressLookupTableAccount({ key: PublicKey.default, state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses } });
  const msg = new TransactionMessage({ payerKey: feePayer, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message([table]);
  return 1 + 64 * msg.header.numRequiredSignatures + msg.serialize().length;
}
/**
 * 'legacy' while the transaction fits in 1,232 bytes, 'v0+lookup-table' when a version 0 transaction with a table for the non-signer accounts fits, otherwise 'too-large'.
 * 11 signers fit only when one of them pays the fee: a separate relayer adds a 12th signature.
 */
export const txShape = (ixs: TransactionInstruction[], feePayer: PublicKey): 'legacy' | 'v0+lookup-table' | 'too-large' =>
  legacySize(ixs, feePayer) <= TX_LIMIT ? 'legacy' : v0BestSize(ixs, feePayer) <= TX_LIMIT ? 'v0+lookup-table' : 'too-large';

/** The instructions that create a lookup table with `addresses` (sign with `authority`, which also pays), and the table's address. Use the table one slot after creation. */
export function lookupTableIxs(authority: PublicKey, recentSlot: number, addresses: PublicKey[]) {
  const [create, table] = AddressLookupTableProgram.createLookupTable({ authority, payer: authority, recentSlot });
  return { table, ixs: [create, AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority, payer: authority, addresses })] };
}
/** The version 0 transaction of `ixs` using `table`; the caller signs it. */
export const compileV0 = (feePayer: PublicKey, blockhash: string, ixs: TransactionInstruction[], table: AddressLookupTableAccount) =>
  new VersionedTransaction(new TransactionMessage({ payerKey: feePayer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message([table]));
