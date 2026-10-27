// Byte readers for the Solana and EVM pre-sign checks: base58, keccak-256 and a bounded
// little-endian reader. Nothing here asks the network; every read is bounds-checked and a short or
// overlong input is a `DecodeError`, never a guess.

/** A byte string that is not what its reader expects. */
export class DecodeError extends Error {}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const B58_INDEX = new Map([...B58].map((c, i) => [c, i]))

/** Base58 (Bitcoin alphabet), as Solana writes keys and signatures. */
export function base58(bytes: Uint8Array): string {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  const digits: number[] = []
  for (const byte of bytes.subarray(zeros)) {
    let carry = byte
    for (let i = 0; i < digits.length; i++) {
      carry += (digits[i] as number) << 8
      digits[i] = carry % 58
      carry = Math.floor(carry / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }
  return (
    '1'.repeat(zeros) +
    digits
      .reverse()
      .map((d) => B58[d])
      .join('')
  )
}

/** Base58 back to bytes; `length` (when given) must be exact. */
export function fromBase58(s: string, length?: number): Uint8Array {
  let zeros = 0
  while (zeros < s.length && s[zeros] === '1') zeros++
  const bytes: number[] = []
  for (const c of s.slice(zeros)) {
    const v = B58_INDEX.get(c)
    if (v === undefined) throw new DecodeError(`not base58: ${JSON.stringify(c)}`)
    let carry = v
    for (let i = 0; i < bytes.length; i++) {
      carry += (bytes[i] as number) * 58
      bytes[i] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  const out = Uint8Array.from([...new Array(zeros).fill(0), ...bytes.reverse()])
  if (length !== undefined && out.length !== length)
    throw new DecodeError(`expected ${length} bytes, got ${out.length}`)
  return out
}

/** A 32-byte Solana public key, in base58. */
export const isSolanaKey = (s: string): boolean => {
  try {
    fromBase58(s, 32)
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)
  } catch {
    return false
  }
}

export const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

// ---- keccak-256 (the pre-NIST padding Ethereum uses), over 64-bit lanes as BigInt ----

const MASK = (1n << 64n) - 1n
const ROUND = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
]
const ROT = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
]
const rotl = (x: bigint, n: number) =>
  n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK

function permute(s: bigint[]) {
  for (const rc of ROUND) {
    const c = [0, 1, 2, 3, 4].map(
      (x) =>
        (s[x] as bigint) ^
        (s[x + 5] as bigint) ^
        (s[x + 10] as bigint) ^
        (s[x + 15] as bigint) ^
        (s[x + 20] as bigint)
    )
    for (let x = 0; x < 5; x++) {
      const d = (c[(x + 4) % 5] as bigint) ^ rotl(c[(x + 1) % 5] as bigint, 1)
      for (let y = 0; y < 25; y += 5) s[x + y] = (s[x + y] as bigint) ^ d
    }
    const b = new Array<bigint>(25).fill(0n)
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++)
        b[y + ((2 * x + 3 * y) % 5) * 5] = rotl(s[x + 5 * y] as bigint, ROT[x + 5 * y] as number)
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 25; y += 5)
        s[x + y] =
          (b[x + y] as bigint) ^
          (~(b[((x + 1) % 5) + y] as bigint) & MASK & (b[((x + 2) % 5) + y] as bigint))
    s[0] = (s[0] as bigint) ^ rc
  }
}

/** keccak-256 of `data`, as Ethereum hashes (selectors, EIP-712). */
export function keccak256(data: Uint8Array): Uint8Array {
  const rate = 136
  const padded = new Uint8Array(Math.floor(data.length / rate) * rate + rate)
  padded.set(data)
  padded[data.length] = (padded[data.length] as number) ^ 0x01
  padded[padded.length - 1] = (padded[padded.length - 1] as number) ^ 0x80
  const s = new Array<bigint>(25).fill(0n)
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j] as number)
      s[i] = (s[i] as bigint) ^ lane
    }
    permute(s)
  }
  const out = new Uint8Array(32)
  for (let i = 0; i < 4; i++) {
    let lane = s[i] as bigint
    for (let j = 0; j < 8; j++) {
      out[i * 8 + j] = Number(lane & 0xffn)
      lane >>= 8n
    }
  }
  return out
}

/** A bounded reader over little-endian (borsh and Solana wire) bytes. */
export class Reader {
  o = 0
  constructor(
    readonly b: Uint8Array,
    /** What is being read, for the error. */
    readonly what: string
  ) {}
  get left() {
    return this.b.length - this.o
  }
  need(n: number) {
    if (n < 0 || this.o + n > this.b.length)
      throw new DecodeError(`${this.what} is cut short at byte ${this.o} (needs ${n} more)`)
  }
  bytes(n: number): Uint8Array {
    this.need(n)
    const out = this.b.subarray(this.o, this.o + n)
    this.o += n
    return out
  }
  u8(): number {
    this.need(1)
    return this.b[this.o++] as number
  }
  u16(): number {
    const x = this.bytes(2)
    return (x[0] as number) | ((x[1] as number) << 8)
  }
  u32(): number {
    const x = this.bytes(4)
    return Buffer.from(x).readUInt32LE(0)
  }
  u64(): bigint {
    return Buffer.from(this.bytes(8)).readBigUInt64LE(0)
  }
  i64(): bigint {
    return Buffer.from(this.bytes(8)).readBigInt64LE(0)
  }
  u128(): bigint {
    const lo = this.u64()
    return (this.u64() << 64n) | lo
  }
  bool(): boolean {
    const v = this.u8()
    if (v > 1) throw new DecodeError(`${this.what}: ${v} is not a bool`)
    return v === 1
  }
  key(): string {
    return base58(this.bytes(32))
  }
  /** A borsh `Vec<T>` (u32 length); `min` is the fewest bytes one item takes, bounding the length. */
  vec<T>(item: () => T, min = 1): T[] {
    const n = this.u32()
    if (n * Math.max(min, 1) > this.left)
      throw new DecodeError(
        `${this.what}: a vector of ${n} does not fit the ${this.left} bytes left`
      )
    return Array.from({ length: n }, item)
  }
  /** A borsh `Vec<u8>`. */
  blob(): Uint8Array {
    return this.bytes(this.u32())
  }
  option<T>(item: () => T): T | null {
    const tag = this.u8()
    if (tag > 1) throw new DecodeError(`${this.what}: ${tag} is not an option tag`)
    return tag === 1 ? item() : null
  }
  string(): string {
    return new TextDecoder('utf-8', { fatal: true }).decode(this.blob())
  }
  /** Solana's compact-u16 (short_vec length). */
  compact(): number {
    let v = 0
    for (let i = 0; i < 3; i++) {
      const b = this.u8()
      v |= (b & 0x7f) << (7 * i)
      if ((b & 0x80) === 0) {
        if (i > 0 && b === 0) throw new DecodeError(`${this.what}: a non-canonical compact-u16`)
        return v
      }
    }
    throw new DecodeError(`${this.what}: a compact-u16 longer than three bytes`)
  }
  /** Every byte was read. */
  end() {
    if (this.left !== 0) throw new DecodeError(`${this.what} carries ${this.left} trailing byte(s)`)
  }
}
