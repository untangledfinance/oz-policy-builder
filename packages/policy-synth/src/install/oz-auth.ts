// Build the authorization entries OpenZeppelin's smart account requires.
//
// This is the piece that makes an end-to-end test of the account -> policy
// path possible. Without it, every attempt to exercise `__check_auth`
// produces a false positive: mocked auth skips `__check_auth` entirely,
// direct invocation is rejected by the host, and recording-mode simulation
// does not verify auth at all.
//
// Two entries are needed per call:
//
//   1. The ACCOUNT's entry. Its `signature` slot is not a signature - OZ puts
//      an `AuthPayload { signers, context_rule_ids }` there, which
//      `__check_auth` receives as its `signatures` argument.
//
//   2. One entry per DELEGATED signer. `do_check_auth` calls
//      `addr.require_auth_for_args((auth_digest,))` for each, which is a
//      nested authorization requirement the host will not record during
//      simulation (it never runs `__check_auth` in recording mode), so it has
//      to be constructed by hand.
//
// The digest OZ binds is NOT the raw auth payload hash:
//
//   auth_digest = sha256(signature_payload || xdr(context_rule_ids))
//
// where `signature_payload` is the standard Soroban authorization preimage
// hash. See `do_check_auth` in
// stellar-contracts/packages/accounts/src/smart_account/storage.rs.

import { Address, hash, xdr } from '@stellar/stellar-sdk'

const sym = (s: string) => xdr.ScVal.scvSymbol(s)
const u32 = (n: number) => xdr.ScVal.scvU32(n)
const vec = (i: xdr.ScVal[]) => xdr.ScVal.scvVec(i)
const bytes = (b: Buffer) => xdr.ScVal.scvBytes(b)

function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  // Entries sorted by key with the default string comparison - ScMap
  // encoding requires the same order Object.keys().sort() produced.
  return xdr.ScVal.scvMap(
    Object.entries(fields)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => new xdr.ScMapEntry({ key: sym(k), val: v }))
  )
}

/** `Signer::Delegated(addr)`. */
export const delegatedSigner = (a: string) => vec([sym('Delegated'), new Address(a).toScVal()])

/** The standard Soroban authorization preimage hash for one entry. */
export function signaturePayload(
  networkPassphrase: string,
  nonce: xdr.Int64,
  signatureExpirationLedger: number,
  invocation: xdr.SorobanAuthorizedInvocation
): Buffer {
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(networkPassphrase)),
      nonce,
      signatureExpirationLedger,
      invocation,
    })
  )
  return hash(preimage.toXDR())
}

/**
 * `sha256(signature_payload || xdr(context_rule_ids))`.
 *
 * OZ binds the selected rule ids into the digest so a signature for one rule
 * cannot be replayed against another.
 */
export function authDigest(payload: Buffer, contextRuleIds: number[]): Buffer {
  const idsXdr = vec(contextRuleIds.map(u32)).toXDR()
  return hash(Buffer.concat([payload, idsXdr]))
}

/** `AuthPayload { signers, context_rule_ids }` - the account's "signature". */
export function authPayload(
  signerAddresses: string[],
  contextRuleIds: number[],
  signatureFor: (addr: string) => Buffer
): xdr.ScVal {
  return struct({
    signers: xdr.ScVal.scvMap(
      signerAddresses
        .map((a) => new xdr.ScMapEntry({ key: delegatedSigner(a), val: bytes(signatureFor(a)) }))
        // Host maps must be sorted by key.
        .sort((x, y) => Buffer.compare(x.key().toXDR(), y.key().toXDR()))
    ),
    context_rule_ids: vec(contextRuleIds.map(u32)),
  })
}

/**
 * The nested entry a `Delegated` signer needs.
 *
 * `require_auth_for_args` authorizes the CURRENT frame, which while
 * `__check_auth` is running is the account contract executing `__check_auth`,
 * with the digest as its single argument.
 *
 * The signer is the transaction source here, so source-account credentials
 * carry it and no separate signature is required.
 */
export function delegatedSignerEntry(
  accountId: string,
  digest: Buffer
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(accountId).toScAddress(),
          functionName: '__check_auth',
          args: [bytes(digest)],
        })
      ),
      subInvocations: [],
    }),
  })
}

/** Rebuild the account's entry with the AuthPayload in the signature slot. */
export function accountEntry(
  original: xdr.SorobanAuthorizationEntry,
  signatureExpirationLedger: number,
  payload: xdr.ScVal
): xdr.SorobanAuthorizationEntry {
  const creds = original.credentials().address()
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: creds.address(),
        nonce: creds.nonce(),
        signatureExpirationLedger,
        signature: payload,
      })
    ),
    rootInvocation: original.rootInvocation(),
  })
}
