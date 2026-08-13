// src/synth/address.ts - Stellar address validation shared by the CLI + the
// run-layer Zod schema.

import { StrKey } from '@stellar/stellar-sdk'

/** True when `s` is a valid Stellar address strkey - either an Ed25519 public
 *  key (`G...`) or a contract address (`C...`). Backed by the SDK's `StrKey`
 *  decoder (the same one the recorder uses in `record/decode.ts`); no
 *  hand-rolled regex. Used to validate a caller-supplied swap recipient
 *  allowlist, whose entries may be either a wallet (`G...`) or a contract
 *  (`C...`). */
export function isStellarAddress(s: string): boolean {
  return StrKey.isValidEd25519PublicKey(s) || StrKey.isValidContract(s)
}
