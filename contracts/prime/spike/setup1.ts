// Setup that needs no NEAR signature: accounts, the 2-of-3 Prime Account, funding.
import { Sdk, XLM, friendbot, keypair, log, save, state, submit } from './stellar.ts';
import { deriveEd25519 } from './near.ts';
import { ethAccountId, metamask } from './mm.ts';
const ACCOUNT_WASM_HASH = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9';
const st = state();
const fee = keypair('secrets/fee-payer.json');
const PATH = 'prime:session-spike/stellar-1';
const admin = Sdk.StrKey.encodeEd25519PublicKey(Buffer.from(await deriveEd25519(ethAccountId, PATH)));
const b = keypair('secrets/admin-b.json'), c = keypair('secrets/admin-c.json');
await friendbot(fee.publicKey()); await friendbot(admin); await friendbot(b.publicKey()); await friendbot(c.publicKey());
const THRESHOLD_POLICY = 'CAYTIVQOEZDOQI4GC3XBXEEYHQUANQQJHPJVMXVRBREGSAP6TCN3DID6'; // pinned simple_threshold, testnet
log('fee payer', fee.publicKey(), 'admin (NEAR MPC, MetaMask', metamask.address + ')', admin);
save({ admin, adminB: b.publicKey(), adminC: c.publicKey(), path: PATH, metamask: metamask.address });
let prime = st.prime;
if (!prime) {
  const { ret, hash } = await submit(fee, Sdk.Operation.createCustomContract({
    address: Sdk.Address.fromString(fee.publicKey()), wasmHash: Buffer.from(ACCOUNT_WASM_HASH, 'hex'),
    constructorArgs: [
      Sdk.xdr.ScVal.scvVec([admin, b.publicKey(), c.publicKey()].map((a) => Sdk.xdr.ScVal.scvVec([Sdk.xdr.ScVal.scvSymbol('Delegated'), new Sdk.Address(a).toScVal()]))),
      Sdk.xdr.ScVal.scvMap([new Sdk.xdr.ScMapEntry({ key: new Sdk.Address(THRESHOLD_POLICY).toScVal(),
        val: Sdk.xdr.ScVal.scvMap([new Sdk.xdr.ScMapEntry({ key: Sdk.xdr.ScVal.scvSymbol('threshold'), val: Sdk.xdr.ScVal.scvU32(2) })]) })]),
    ],
  }));
  prime = Sdk.Address.fromScVal(ret!).toString(); save({ prime, primeTx: hash }); log('Prime Account (rule 0: A=NEAR/MetaMask, B, C; 2 of 3)', prime, hash);
}
if (!st.funded) {
  const { hash } = await submit(fee, new Sdk.Contract(XLM).call('transfer', new Sdk.Address(fee.publicKey()).toScVal(), new Sdk.Address(prime).toScVal(), Sdk.nativeToScVal(500_000_000n, { type: 'i128' })));
  save({ funded: hash }); log('funded Prime with 50 XLM', hash);
}
