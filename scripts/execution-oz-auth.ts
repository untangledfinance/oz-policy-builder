// Copied from prime-ts-sdk 0fcbb0c325d2bebc077fa944a7899c342a0bd29e, src/policy/oz-account-auth.ts.
// Authorization entries for OpenZeppelin's Stellar smart account.
//
// Ported from the policy-synth install internals (not part of its public
// API); the wire shapes are defined by the deployed account wasm this SDK
// already pins, so they change only when the account contract does.
//
// Two entries authorize one account invocation:
//   1. the ACCOUNT's entry - its `signature` slot carries an
//      `AuthPayload { signers, context_rule_ids }`, which `__check_auth`
//      receives as its `signatures` argument;
//   2. one entry per DELEGATED signer - `require_auth_for_args((digest,))`
//      against the account contract's `__check_auth` frame. When the signer
//      is the transaction source, source-account credentials carry it and no
//      separate signature is needed.
//
// The digest the account binds is NOT the raw payload hash:
//   auth_digest = sha256(signature_payload || xdr(context_rule_ids))
// so a signature for one rule set cannot be replayed against another.
import { Address, hash, xdr } from '@stellar/stellar-sdk'

const sym = (s: string) => xdr.ScVal.scvSymbol(s)
const u32 = (n: number) => xdr.ScVal.scvU32(n)
const vec = (i: xdr.ScVal[]) => xdr.ScVal.scvVec(i)

/** `Signer::Delegated(addr)` in wire form. */
export function delegatedSigner(addr: string): xdr.ScVal {
  return vec([sym('Delegated'), new Address(addr).toScVal()])
}

/** The standard Soroban authorization preimage hash for one entry. */
export function signaturePayload(
  networkPassphrase: string,
  nonce: xdr.Int64,
  signatureExpirationLedger: number,
  invocation: xdr.SorobanAuthorizedInvocation
): Uint8Array {
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

/** `sha256(signature_payload || xdr(context_rule_ids))`. */
export function authDigest(payload: Uint8Array, contextRuleIds: number[]): Uint8Array {
  const idsXdr = vec(contextRuleIds.map(u32)).toXDR()
  return hash(Buffer.concat([Buffer.from(payload), idsXdr]))
}

/** `AuthPayload { signers, context_rule_ids }` - the account's "signature". */
export function authPayload(signerAddresses: string[], contextRuleIds: number[]): xdr.ScVal {
  const signers = xdr.ScVal.scvMap(
    signerAddresses
      .map(
        (a) =>
          new xdr.ScMapEntry({ key: delegatedSigner(a), val: xdr.ScVal.scvBytes(Buffer.alloc(0)) })
      )
      .sort((x, y) => Buffer.compare(x.key().toXDR(), y.key().toXDR()))
  )
  // ScMap field order must match Object.keys().sort() of the struct.
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: sym('context_rule_ids'), val: vec(contextRuleIds.map(u32)) }),
    new xdr.ScMapEntry({ key: sym('signers'), val: signers }),
  ])
}

/** The nested entry a `Delegated` signer needs when it is the tx source. */
export function delegatedSignerEntry(
  accountId: string,
  digest: Uint8Array
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(accountId).toScAddress(),
          functionName: '__check_auth',
          args: [xdr.ScVal.scvBytes(Buffer.from(digest))],
        })
      ),
      subInvocations: [],
    }),
  })
}

/** Rebuild the account's simulated entry with the AuthPayload in the signature slot. */
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
