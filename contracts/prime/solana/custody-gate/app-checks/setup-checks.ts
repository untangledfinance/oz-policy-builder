// The checks the Prime app makes around custody's setup of a gate-owned token account. Each function reads bytes or builds instructions; none holds a key or sends a transaction.
//   1. custody's multisig: m <= n, every slot is a key the setup knows, a zero-amount test signature proves the intended signers reach m and custody's keys alone do not
//   2. the trustee is mandatory: no set of custody's keys reaches m (duplicate trustee slots give the trustee weight)
//   3. the account that goes under the gate: a dedicated (non-associated) account of exactly 165 bytes, so no extension (CPI guard, memo, fee, hook) can block the gate's token calls
//   4. the hand-over: close authority first, then owner, both to the gate PDA; read the account back and confirm owner and close authority are the gate (close authority none for wrapped SOL)
//   5. an 11-signer multisig needs a version 0 transaction and a lookup table

import {
  AuthorityType,
  createSetAuthorityInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  type Connection,
  type Keypair,
  PublicKey,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'

export const MULTISIG_LEN = 355,
  MAX_SIGNERS = 11,
  TX_LIMIT = 1232,
  TOKEN_ACCOUNT_LEN = 165
export type Issue = { code: string; message: string }
export type Multisig = { m: number; n: number; initialized: boolean; slots: PublicKey[] }

/** The SPL multisig layout: m, n, initialized flag, 11 signer slots of 32 bytes. Only the first n slots count. */
export function parseMultisig(data: Uint8Array): Multisig {
  if (data.length !== MULTISIG_LEN)
    throw new Error(`multisig account is ${MULTISIG_LEN} bytes, got ${data.length}`)
  const [m, n, init] = data
  if (n > MAX_SIGNERS) throw new Error(`n = ${n} exceeds ${MAX_SIGNERS} slots`)
  const slots = Array.from(
    { length: n },
    (_, i) => new PublicKey(data.subarray(3 + 32 * i, 35 + 32 * i))
  )
  return { m, n, initialized: init === 1, slots }
}

/** What the token program counts: every slot held by a key that signs, so a key listed k times carries weight k. */
export function weight(ms: Multisig, signing: PublicKey[]): number {
  const set = new Set(signing.map((k) => k.toBase58()))
  return ms.slots.filter((s) => set.has(s.toBase58())).length
}

/**
 * Issues with the multisig that is custody's identity. `custody` are the keys custody controls (its main key and any backup), `trustee` is the second party.
 * The token program accepts m > n (no set of signers can ever satisfy it: no release, no cap increase) and a 2-of-3 whose two custody keys alone reach 2.
 */
export function checkMultisig(
  ms: Multisig,
  who: { custody: PublicKey[]; trustee: PublicKey }
): Issue[] {
  if (!ms.initialized)
    return [{ code: 'multisig-uninitialized', message: 'the multisig account is not initialised' }]
  const out: Issue[] = []
  if (ms.m < 2)
    out.push({
      code: 'm-below-two',
      message: `m = ${ms.m}: one key alone releases the account and raises the cap`,
    })
  if (ms.m > ms.n)
    out.push({
      code: 'm-greater-than-n',
      message: `m = ${ms.m} exceeds n = ${ms.n}: no set of signers can ever release the account or raise the cap`,
    })
  const known = new Set([...who.custody, who.trustee].map((k) => k.toBase58()))
  for (const s of ms.slots)
    if (!known.has(s.toBase58()))
      out.push({
        code: 'unknown-signer',
        message: `slot ${s.toBase58()} is not a key custody or the trustee controls`,
      })
  if (weight(ms, who.custody) >= ms.m)
    out.push({
      code: 'custody-reaches-m',
      message: `custody's keys alone hold weight ${weight(ms, who.custody)} of the ${ms.m} needed: the trustee is not mandatory`,
    })
  if (weight(ms, [who.trustee]) >= ms.m)
    out.push({
      code: 'trustee-reaches-m',
      message: `the trustee alone holds weight ${weight(ms, [who.trustee])} of the ${ms.m} needed`,
    })
  return out
}

/**
 * The slot list that keeps the trustee mandatory while any one custody key plus the trustee still reaches m: custody's keys once each, the trustee m - 1 times.
 * [custody, trustee] for 2-of-2; [custody, backup, trustee, trustee] for m = 3. Throws when custody's keys alone would reach m or the list exceeds 11 slots.
 */
export function weightedSlots(custody: PublicKey[], trustee: PublicKey, m: number): PublicKey[] {
  if (!Number.isInteger(m) || m < 2)
    throw new Error('m must be an integer of at least 2: with m = 1 any single key moves funds')
  const distinct = new Set(custody.map((k) => k.toBase58()))
  if (distinct.size !== custody.length || distinct.has(trustee.toBase58()))
    throw new Error('custody keys must be distinct and differ from the trustee')
  if (custody.length < 1) throw new Error('custody needs at least one key')
  if (custody.length >= m)
    throw new Error(`custody's ${custody.length} keys would reach m = ${m} without the trustee`)
  const slots = [...custody, ...Array.from({ length: m - 1 }, () => trustee)]
  if (slots.length > MAX_SIGNERS)
    throw new Error(`${slots.length} slots exceed the limit of ${MAX_SIGNERS}`)
  return slots
}

/** A zero-amount transfer from a multisig-owned token account to itself. It moves nothing and passes only if `signers` authorise the multisig. */
export function testSignatureIx(
  account: PublicKey,
  ms: PublicKey,
  signers: PublicKey[],
  program: PublicKey = TOKEN_PROGRAM_ID
): TransactionInstruction {
  return createTransferInstruction(account, account, ms, 0n, signers, program)
}

/** Simulates the test signature signed by `signers` (fee paid by `feePayer`) with signature verification on. Returns whether the token program accepted it. */
export async function simulateTestSignature(
  conn: Connection,
  o: {
    account: PublicKey
    ms: PublicKey
    program?: PublicKey
    signers: Keypair[]
    feePayer: Keypair
  }
): Promise<{ ok: boolean; error: string }> {
  const ix = testSignatureIx(
    o.account,
    o.ms,
    o.signers.map((k) => k.publicKey),
    o.program
  )
  const msg = new TransactionMessage({
    payerKey: o.feePayer.publicKey,
    recentBlockhash: (await conn.getLatestBlockhash('confirmed')).blockhash,
    instructions: [ix],
  }).compileToV0Message()
  const t = new VersionedTransaction(msg)
  t.sign([o.feePayer, ...o.signers.filter((k) => !k.publicKey.equals(o.feePayer.publicKey))])
  const r = await conn.simulateTransaction(t, { sigVerify: true })
  return {
    ok: r.value.err === null,
    error:
      r.value.err === null
        ? ''
        : `${JSON.stringify(r.value.err)} ${(r.value.logs ?? []).filter((l) => /failed|error/i.test(l)).join(' | ')}`.trim(),
  }
}

const u32 = (d: Uint8Array, o: number) =>
  new DataView(d.buffer, d.byteOffset + o, 4).getUint32(0, true)
const pk = (d: Uint8Array, o: number) => new PublicKey(d.subarray(o, o + 32))
export type TokenAccount = {
  mint: PublicKey
  owner: PublicKey
  delegate: PublicKey | null
  delegatedAmount: bigint
  frozen: boolean
  native: boolean
  closeAuthority: PublicKey | null
  length: number
}

/** The base token account layout shared by Token and Token-2022: mint 0, owner 32, amount 64, delegate 72, state 108, is_native 109, delegated amount 121, close authority 129. */
export function parseTokenAccount(data: Uint8Array): TokenAccount {
  if (data.length < TOKEN_ACCOUNT_LEN) throw new Error(`not a token account: ${data.length} bytes`)
  if (data[108] === 0) throw new Error('token account is not initialised')
  return {
    mint: pk(data, 0),
    owner: pk(data, 32),
    delegate: u32(data, 72) === 1 ? pk(data, 76) : null,
    frozen: data[108] === 2,
    native: u32(data, 109) === 1,
    delegatedAmount: new DataView(data.buffer, data.byteOffset + 121, 8).getBigUint64(0, true),
    closeAuthority: u32(data, 129) === 1 ? pk(data, 133) : null,
    length: data.length,
  }
}

/**
 * Issues with a token account before custody hands it to the gate. The account must be a dedicated one (not the associated account of its owner), exactly 165 bytes with no extension:
 * an extension such as the Token-2022 CPI guard would block the gate's own transfer, approve and set-authority calls and freeze the funds. A fee or hook mint adds extensions on its own.
 */
export function checkSourceAccount(
  address: PublicKey,
  data: Uint8Array,
  program: PublicKey
): Issue[] {
  if (!program.equals(TOKEN_PROGRAM_ID) && !program.equals(TOKEN_2022_PROGRAM_ID))
    return [{ code: 'not-a-token-program', message: 'only Token and Token-2022 are supported' }]
  const a = parseTokenAccount(data),
    out: Issue[] = []
  if (getAssociatedTokenAddressSync(a.mint, a.owner, true, program).equals(address))
    out.push({
      code: 'associated-account',
      message:
        'an associated account names its owner in its address and a Token-2022 one has an immutable owner: move the funds into a dedicated account',
    })
  if (a.length !== TOKEN_ACCOUNT_LEN)
    out.push({
      code: 'extensions',
      message: `${a.length} bytes: the account carries extensions (CPI guard, memo, transfer fee or hook) that can block the gate's token calls`,
    })
  if (a.frozen) out.push({ code: 'frozen', message: 'the account is frozen' })
  return out
}

export type MintCheck = {
  program: 'token' | 'token-2022' | null
  /** The mint must not be used: the gate cannot hold it safely, or the mint could not be read. Empty means the app may go on. */
  refuse: Issue[]
  /** What the app must show the user before funds move. A warning is not a refusal. */
  warn: Issue[]
}
const MINT_LEN = 82,
  MINT_ACCOUNT_TYPE = 165,
  MINT_TLV_START = 166
export const FREEZE_WARNING =
  'the issuer can freeze this account; while frozen, recovery and release are refused'
// Mint extensions by Token-2022 type id. Anything not listed here is refused as unknown: a new extension may change what the issuer can do to a gate-owned account.
const EXT_REFUSE: Record<number, [string, string]> = {
  1: [
    'transfer-fee',
    "a transfer fee takes a cut of every transfer, so the gate's plain transfer is refused by the token program",
  ],
  4: ['confidential-transfer', 'confidential transfers hide balances from the gate and its checks'],
  9: [
    'non-transferable',
    'a non-transferable mint cannot be moved, so neither the agent, recovery nor release can run',
  ],
  12: [
    'permanent-delegate',
    'a permanent delegate can move any account of this mint with no gate call and no cap',
  ],
  14: [
    'transfer-hook',
    "a transfer hook runs another program on every transfer and can block the gate's transfers",
  ],
  16: [
    'confidential-transfer-fee',
    'confidential transfer fees hide balances from the gate and its checks',
  ],
  24: ['confidential-mint-burn', 'a confidential mint hides balances from the gate and its checks'],
}
// Extensions that leave the raw token amount, the transfer and the account authorities alone: [name, fixed length or 0 for variable].
const EXT_BENIGN: Record<number, [string, number]> = {
  3: ['mint-close-authority', 32],
  10: ['interest-bearing', 52],
  18: ['metadata-pointer', 64],
  19: ['token-metadata', 0],
  20: ['group-pointer', 64],
  21: ['token-group', 80],
  22: ['group-member-pointer', 64],
  23: ['token-group-member', 72],
  25: ['scaled-ui-amount', 56],
}
const EXT_PAUSABLE = 26,
  EXT_DEFAULT_STATE = 6,
  PAUSABLE_LEN = 33

/**
 * Reads a mint account (owner program and data) before funds move and decides whether the gate can hold it. It refuses a Token-2022 mint with a permanent delegate, a transfer hook, a transfer fee,
 * confidential transfers, non-transferable tokens or frozen-by-default accounts, and any extension it cannot parse (fail closed). It warns, for the app to show, when the mint has a freeze authority
 * (USDC and USDT do) or a pause authority, and when the mint sits under Token-2022: the classic Token program is immutable and Token-2022 is upgradeable on mainnet, so prefer the classic Token program.
 */
export function checkMint(mint: { owner: PublicKey; data: Uint8Array }): MintCheck {
  const refuse: Issue[] = [],
    warn: Issue[] = [],
    d = mint.data
  const stop = (code: string, message: string): MintCheck => ({
    program,
    refuse: [...refuse, { code, message }],
    warn,
  })
  const program = mint.owner.equals(TOKEN_PROGRAM_ID)
    ? 'token'
    : mint.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? 'token-2022'
      : null
  if (program === null)
    return stop(
      'not-a-token-program',
      `the mint is owned by ${mint.owner.toBase58()}: only Token and Token-2022 are supported`
    )
  if (d.length < MINT_LEN || (program === 'token' && d.length !== MINT_LEN))
    return stop('malformed-mint', `a mint account of ${d.length} bytes is not a ${program} mint`)
  if (d[45] !== 1) return stop('malformed-mint', 'the mint is not initialised')
  const tag = u32(d, 46)
  if (tag > 1 || u32(d, 0) > 1)
    return stop('malformed-mint', 'a mint authority or freeze authority flag is neither 0 nor 1')
  if (tag === 1)
    warn.push({
      code: 'freeze-authority',
      message: `${FREEZE_WARNING} (freeze authority ${pk(d, 50).toBase58()})`,
    })
  if (program === 'token-2022') {
    warn.push({
      code: 'token-2022',
      message:
        'Token-2022 is upgradeable on mainnet, so its upgrade authority becomes a trusted party; the classic Token program is immutable: prefer it where the asset allows',
    })
    if (d.length > MINT_LEN) {
      if (d.length < MINT_TLV_START || d[MINT_ACCOUNT_TYPE] !== 1)
        return stop(
          'malformed-mint',
          'the mint account carries bytes after the base mint but no Token-2022 mint marker'
        )
      let o = MINT_TLV_START
      while (o < d.length) {
        if (o + 4 > d.length) return stop('malformed-mint', 'an extension header is cut off')
        const type = new DataView(d.buffer, d.byteOffset + o, 2).getUint16(0, true),
          len = new DataView(d.buffer, d.byteOffset + o + 2, 2).getUint16(0, true),
          v = d.subarray(o + 4, o + 4 + len)
        if (type === 0) {
          if (d.subarray(o).some((b) => b !== 0))
            return stop('malformed-mint', 'bytes after the last extension are not zero')
          break
        }
        if (o + 4 + len > d.length)
          return stop('malformed-mint', `extension ${type} is cut off: it claims ${len} bytes`)
        o += 4 + len
        if (EXT_REFUSE[type])
          refuse.push({ code: EXT_REFUSE[type][0], message: EXT_REFUSE[type][1] })
        else if (type === EXT_DEFAULT_STATE) {
          if (len !== 1 || (v[0] !== 1 && v[0] !== 2))
            return stop(
              'malformed-mint',
              'the default account state extension is not 1 byte holding initialised or frozen'
            )
          if (v[0] === 2)
            refuse.push({
              code: 'default-account-state-frozen',
              message:
                'every new account of this mint starts frozen: the gate-owned account could never move funds',
            })
        } else if (type === EXT_PAUSABLE) {
          if (len !== PAUSABLE_LEN)
            return stop('malformed-mint', 'the pausable extension has the wrong length')
          warn.push({
            code: 'pausable',
            message:
              'the issuer can pause every transfer of this mint; while paused, recovery and release are refused',
          })
        } else if (EXT_BENIGN[type]) {
          const [name, want] = EXT_BENIGN[type]
          if (want === 0 ? len < 76 : len !== want)
            return stop('malformed-mint', `the ${name} extension has the wrong length (${len})`)
        } else
          refuse.push({
            code: 'unknown-extension',
            message: `extension type ${type} is not one this check knows: it may let a third party move or block the account`,
          })
      }
    }
  }
  return { program, refuse, warn }
}

export const GATE_FIXED_LEN = 181
export type GateState = {
  multisig: PublicKey
  settings: PublicKey
  agentLane: PublicKey
  ownersLane: PublicKey
  recovery: PublicKey
  until: bigint
  window: number
  seed: Uint8Array
  bump: number
  destinations: PublicKey[]
}

/** The gate account written by `create`: multisig 0, settings 32, agent lane vault 64, owners lane vault 96, recovery 128, until i64 160, window u32 168, seed 172, bump 180, destinations (32 each) from 181. */
export function parseGate(data: Uint8Array): GateState {
  if (data.length < GATE_FIXED_LEN || (data.length - GATE_FIXED_LEN) % 32 !== 0)
    throw new Error(
      `a gate account is ${GATE_FIXED_LEN} bytes plus 32 per destination, got ${data.length}`
    )
  const v = new DataView(data.buffer, data.byteOffset, data.length)
  return {
    multisig: pk(data, 0),
    settings: pk(data, 32),
    agentLane: pk(data, 64),
    ownersLane: pk(data, 96),
    recovery: pk(data, 128),
    until: v.getBigInt64(160, true),
    window: v.getUint32(168, true),
    seed: data.slice(172, 180),
    bump: data[180],
    destinations: Array.from({ length: (data.length - GATE_FIXED_LEN) / 32 }, (_, i) =>
      pk(data, GATE_FIXED_LEN + 32 * i)
    ),
  }
}

export type ExpectedGate = {
  program: PublicKey
  multisig: PublicKey
  settings: PublicKey
  agentLane: PublicKey
  ownersLane: PublicKey
  recovery: PublicKey
  until: bigint | number
  window: number
  seed: Uint8Array
  destinations: PublicKey[]
  /** Keys custody controls (and the multisig itself): the recovery address must be none of them. */
  custody: PublicKey[]
}
export const gateAddress = (
  program: PublicKey,
  multisig: PublicKey,
  settings: PublicKey,
  seed: Uint8Array
) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from('gate'), multisig.toBuffer(), settings.toBuffer(), seed],
    program
  )

/**
 * Compares a gate account with what custody and the owners expect. Run it before custody hands any token account over (the hand-over cannot be undone except by a release) and again when the owners
 * confirm the gate, before they install any rule. Any one member of the multisig can create a gate, so every fixed field is compared, not just the recovery address. An empty result means the gate matches.
 */
export function checkGate(
  gate: { address: PublicKey; owner: PublicKey; data: Uint8Array },
  want: ExpectedGate
): Issue[] {
  if (!gate.owner.equals(want.program))
    return [
      {
        code: 'gate-owner',
        message: `the account is owned by ${gate.owner.toBase58()}, not by the gate program ${want.program.toBase58()}`,
      },
    ]
  let g: GateState
  try {
    g = parseGate(gate.data)
  } catch (e) {
    return [{ code: 'gate-malformed', message: String((e as Error).message) }]
  }
  const out: Issue[] = [],
    bad = (code: string, what: string, got: string, exp: string) =>
      out.push({ code, message: `${what} is ${got}, expected ${exp}` })
  const key = (code: string, what: string, got: PublicKey, exp: PublicKey) => {
    if (!got.equals(exp)) bad(code, what, got.toBase58(), exp.toBase58())
  }
  const [pda, bump] = gateAddress(want.program, want.multisig, want.settings, want.seed)
  key('gate-address', 'the gate address', gate.address, pda)
  if (g.bump !== bump) bad('gate-bump', 'the stored bump', String(g.bump), String(bump))
  key('gate-multisig', 'the custody multisig', g.multisig, want.multisig)
  key('gate-settings', 'the Prime settings', g.settings, want.settings)
  key('gate-agent-lane', 'the agent lane vault', g.agentLane, want.agentLane)
  key('gate-owners-lane', 'the owners lane vault', g.ownersLane, want.ownersLane)
  key('gate-recovery', 'the recovery address', g.recovery, want.recovery)
  if (g.until !== BigInt(want.until))
    bad('gate-until', 'the end time', String(g.until), String(want.until))
  if (g.window !== want.window)
    bad('gate-window', 'the window', String(g.window), String(want.window))
  if (Buffer.compare(g.seed, want.seed) !== 0)
    bad(
      'gate-seed',
      'the seed',
      Buffer.from(g.seed).toString('hex'),
      Buffer.from(want.seed).toString('hex')
    )
  if (
    g.destinations.length !== want.destinations.length ||
    g.destinations.some((x, i) => !x.equals(want.destinations[i]))
  )
    bad(
      'gate-destinations',
      'the destination list',
      `[${g.destinations.map(String).join(', ')}]`,
      `[${want.destinations.map(String).join(', ')}]`
    )
  if (g.recovery.equals(PublicKey.default))
    out.push({
      code: 'recovery-unset',
      message: 'the recovery address is empty: a recovery would send funds to no one',
    })
  if ([want.multisig, ...want.custody].some((c) => c.equals(g.recovery)))
    out.push({
      code: 'recovery-is-custody',
      message:
        "the recovery address is custody's own (or the multisig): a recovery must land outside custody's control",
    })
  if (g.destinations.some((x) => x.equals(g.recovery)))
    out.push({
      code: 'recovery-is-destination',
      message:
        'the recovery address is also a listed destination: keep the two apart so a capped draw and an uncapped recovery cannot be confused',
    })
  return out
}

/** The two SetAuthority calls that hand a dedicated account to the gate PDA: close authority first, then owner. `closer` is the current close authority, or the owner when none is set; it signs both. */
export function handOverIxs(
  account: PublicKey,
  closer: PublicKey,
  gate: PublicKey,
  program: PublicKey = TOKEN_PROGRAM_ID
): TransactionInstruction[] {
  return [AuthorityType.CloseAccount, AuthorityType.AccountOwner].map((t) =>
    createSetAuthorityInstruction(account, closer, t, gate, [], program)
  )
}

/**
 * Reads an account back after the hand-over: the owner must be the gate and the close authority the gate (none for wrapped SOL, where Token clears it on the owner change),
 * with no stale delegate. Run it before the multisig raises the cap: the gate refuses a cap while another party holds the close authority.
 */
export function checkHandedOver(data: Uint8Array, gate: PublicKey): Issue[] {
  const a = parseTokenAccount(data),
    out: Issue[] = []
  if (!a.owner.equals(gate))
    out.push({ code: 'owner-not-gate', message: `owner is ${a.owner.toBase58()}, not the gate` })
  const closeOk = a.native
    ? a.closeAuthority === null || a.closeAuthority.equals(gate)
    : a.closeAuthority?.equals(gate) === true
  if (!closeOk)
    out.push({
      code: 'close-authority-not-gate',
      message: `close authority is ${a.closeAuthority?.toBase58() ?? 'none'}: custody could close the emptied account and reopen the address as its own`,
    })
  if (a.delegate !== null || a.delegatedAmount !== 0n)
    out.push({
      code: 'stale-delegate',
      message: `a delegate ${a.delegate?.toBase58()} still holds ${a.delegatedAmount}`,
    })
  if (a.length !== TOKEN_ACCOUNT_LEN)
    out.push({ code: 'extensions', message: `${a.length} bytes: the account carries extensions` })
  return out
}

/** Bytes of `ixs` as one legacy transaction: signature count, signatures, message. */
export function legacySize(ixs: TransactionInstruction[], feePayer: PublicKey): number {
  const msg = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: ixs,
  }).compileToLegacyMessage()
  return 1 + 64 * msg.header.numRequiredSignatures + msg.serialize().length
}
/** Bytes of `ixs` as a version 0 transaction whose lookup table holds every account key (the best case a table can give: signers and program ids stay static). */
export function v0BestSize(ixs: TransactionInstruction[], feePayer: PublicKey): number {
  const addresses = [
    ...new Map(
      ixs.flatMap((i) => i.keys.map((k) => [k.pubkey.toBase58(), k.pubkey] as const))
    ).values(),
  ] // the compiler keeps signers and program ids static
  const table = new AddressLookupTableAccount({
    key: PublicKey.default,
    state: {
      deactivationSlot: 2n ** 64n - 1n,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses,
    },
  })
  const msg = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: ixs,
  }).compileToV0Message([table])
  return 1 + 64 * msg.header.numRequiredSignatures + msg.serialize().length
}
/**
 * 'legacy' while the transaction fits in 1,232 bytes, 'v0+lookup-table' when a version 0 transaction with a table for the non-signer accounts fits, otherwise 'too-large'.
 * 11 signers fit only when one of them pays the fee: a separate relayer adds a 12th signature.
 */
export const txShape = (
  ixs: TransactionInstruction[],
  feePayer: PublicKey
): 'legacy' | 'v0+lookup-table' | 'too-large' =>
  legacySize(ixs, feePayer) <= TX_LIMIT
    ? 'legacy'
    : v0BestSize(ixs, feePayer) <= TX_LIMIT
      ? 'v0+lookup-table'
      : 'too-large'

/** The instructions that create a lookup table with `addresses` (sign with `authority`, which also pays), and the table's address. Use the table one slot after creation. */
export function lookupTableIxs(authority: PublicKey, recentSlot: number, addresses: PublicKey[]) {
  const [create, table] = AddressLookupTableProgram.createLookupTable({
    authority,
    payer: authority,
    recentSlot,
  })
  return {
    table,
    ixs: [
      create,
      AddressLookupTableProgram.extendLookupTable({
        lookupTable: table,
        authority,
        payer: authority,
        addresses,
      }),
    ],
  }
}
/** The version 0 transaction of `ixs` using `table`; the caller signs it. */
export const compileV0 = (
  feePayer: PublicKey,
  blockhash: string,
  ixs: TransactionInstruction[],
  table: AddressLookupTableAccount
) =>
  new VersionedTransaction(
    new TransactionMessage({
      payerKey: feePayer,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message([table])
  )
