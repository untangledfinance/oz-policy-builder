// Copied from prime-ts-sdk 0fcbb0c325d2bebc077fa944a7899c342a0bd29e for this reproducible experiment.
// Counterfactual Soroban contract id for the "policy smart account on
// Stellar" card (OpenZeppelin smart account `C…`).
//
// Convention (pinned 2026-09-10): the deployer is the Prime relayer's
// MPC-derived Stellar account (the relayer sponsors activation and signs
// via NEAR Chain Signatures), and the salt is a versioned hash of the
// Prime's NEAR identity, so one Prime maps to ONE deterministic contract
// id per network:
//
//   salt        = sha256(utf8("prime-v1|" + nearAccountId))
//   contract_id = sha256(HashIDPreimage::CONTRACT_ID {
//                   networkId: sha256(passphrase),
//                   fromAddress { address: deployer, salt } })
//
// Read-only: nothing is deployed, no funds move. The id is only meaningful
// if the future activation deploys with EXACTLY these inputs (deployer,
// salt, network).
//
// Requires the peer dependency `@stellar/stellar-sdk` (the authority on the
// XDR preimage encoding — nothing here is hand-rolled).

/** Versioned salt for the pinned deployment convention. 32 raw bytes. */
export async function primeStellarSalt(nearAccountId: string): Promise<Uint8Array> {
  const { hash } = await import("@stellar/stellar-sdk");
  return new Uint8Array(hash(Buffer.from(`prime-v1|${nearAccountId}`, "utf8")));
}

/**
 * Compute the counterfactual Soroban contract id (`C…` StrKey) for a
 * deployer + salt on a network. Pure offline XDR hashing — no RPC.
 */
export async function counterfactualStellarContractId(args: {
  /** The deployer's Stellar address (`G…` account or `C…` contract). */
  deployer: string;
  /** 32-byte deployment salt (see {@link primeStellarSalt}). */
  salt: Uint8Array;
  /** Network passphrase (e.g. `Networks.PUBLIC`). */
  networkPassphrase: string;
}): Promise<string> {
  if (args.salt.length !== 32) {
    throw new Error(`Stellar deployment salt must be 32 bytes, got ${args.salt.length}`);
  }
  const { Address, StrKey, hash, xdr } = await import("@stellar/stellar-sdk");
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(args.networkPassphrase, "utf8")),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: Address.fromString(args.deployer).toScAddress(),
          salt: Buffer.from(args.salt),
        }),
      ),
    }),
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}
