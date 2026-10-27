// Program-derived addresses as Solana derives them (`Pubkey::find_program_address`), with the
// Squads Smart Account's seeds for a rule and a vault (state/seeds.rs at `0e51082`). No network.

import { createHash } from 'node:crypto'
import { base58, DecodeError, fromBase58 } from './bytes.ts'

const SMART_ACCOUNT = 'SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG'

export const sha256 = (...parts: Uint8Array[]) => {
  const h = createHash('sha256')
  for (const p of parts) h.update(p)
  return new Uint8Array(h.digest())
}

// Ed25519: whether 32 bytes decompress to a curve point (curve25519-dalek's
// CompressedEdwardsY::decompress, which a program address must fail).
const P = 2n ** 255n - 19n
const D = (P - ((121665n * inv(121666n)) % P)) % P
function pow(b: bigint, e: bigint): bigint {
  let r = 1n
  let x = ((b % P) + P) % P
  for (let k = e; k > 0n; k >>= 1n) {
    if (k & 1n) r = (r * x) % P
    x = (x * x) % P
  }
  return r
}
function inv(x: bigint): bigint {
  return pow(x, P - 2n)
}
export function onCurve(key: Uint8Array): boolean {
  let y = 0n
  for (let k = 31; k >= 0; k--) y = (y << 8n) | BigInt(key[k] as number)
  y &= (1n << 255n) - 1n
  y %= P
  const y2 = (y * y) % P
  const u = (y2 - 1n + P) % P
  const v = (D * y2 + 1n) % P
  // x = u v^3 (u v^7)^((p-5)/8); a square root of u/v exists iff v x^2 = ±u (or ±u·sqrt(-1) case folds in)
  const v3 = (v * v * v) % P
  const x = (u * v3 * pow(u * v3 * v3 * v, (P - 5n) / 8n)) % P
  const vx2 = (v * x * x) % P
  if (vx2 === u) return true
  if (vx2 === (P - u) % P) return true // x · sqrt(-1) is the root
  return false
}

/** `Pubkey::find_program_address`. */
export function programAddress(seeds: Uint8Array[], program: string): string {
  const id = fromBase58(program, 32)
  const marker = new TextEncoder().encode('ProgramDerivedAddress')
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(...seeds, Uint8Array.of(bump), id, marker)
    if (!onCurve(h)) return base58(h)
  }
  throw new DecodeError('no program address off the curve')
}
export const te = (s: string) => new TextEncoder().encode(s)
const u64le = (n: bigint | number) => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n))
  return new Uint8Array(b)
}
/** A rule of a Squads account (state/seeds.rs:47-54). */
export const policyAddress = (settings: string, seed: bigint | number): string =>
  programAddress(
    [te('smart_account'), te('policy'), fromBase58(settings, 32), u64le(seed)],
    SMART_ACCOUNT
  )
/** Vault `index` of a Squads account (state/seeds.rs:57-68). */
export const vaultAddress = (settings: string, index: number): string =>
  programAddress(
    [te('smart_account'), fromBase58(settings, 32), te('smart_account'), Uint8Array.of(index)],
    SMART_ACCOUNT
  )
