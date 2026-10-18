// Stellar payloads: SEP-53 prime-near-signer text, Soroban grant auth entry preimage, seat-vote auth entry preimage, a testnet payment.
import * as Sdk from '@stellar/stellar-sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
const H = '/home/ubuntu/work/wallet-matrix/real';
const st = JSON.parse(readFileSync('/home/ubuntu/work/near-session-spike/state-stn.json', 'utf8'));
const pub = JSON.parse(readFileSync(`${H}/secrets/pub.json`, 'utf8'));
const { xdr } = Sdk, PASS = Sdk.Networks.TESTNET;
const server = new Sdk.rpc.Server('https://soroban-testnet.stellar.org');
const latest = (await server.getLatestLedger()).sequence;
const key = randomBytes(32), until = latest + 17280;
const preimage = (contract, fn, args, exp, n) => xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(new xdr.HashIdPreimageSorobanAuthorization({
  networkId: Sdk.hash(Buffer.from(PASS)), nonce: n, signatureExpirationLedger: exp,
  invocation: new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({ contractAddress: new Sdk.Address(contract).toScAddress(), functionName: fn, args })), subInvocations: [] }) })).toXDR('base64');
const grant = preimage(st.S_rf, 'grant', [xdr.ScVal.scvBytes(key), xdr.ScVal.scvU32(until)], latest + 100, 1234567890123n);
const digest = randomBytes(32);
const vote = preimage(st.prime, '__check_auth', [xdr.ScVal.scvBytes(digest)], latest + 100, 987654321987n);
const acct = new Sdk.Account(pub.stellar, '1000');
const tx = new Sdk.TransactionBuilder(acct, { fee: '100', networkPassphrase: PASS }).addOperation(Sdk.Operation.payment({ destination: Sdk.Keypair.random().publicKey(), asset: Sdk.Asset.native(), amount: '1' })).setTimeout(0).build();
const nearText = `Prime NEAR signer\ncontract: signer.prime-spike-muwguc60.testnet\npath: prime:stellar\ndomain: 1\npayload: ${createHash('sha256').update('wm-near-payload-stellar').digest('hex')}`;
writeFileSync(`${H}/payloads/stellar.json`, JSON.stringify({ address: pub.stellar, passphrase: PASS, nearText, grantContract: st.S_rf, grantKey: key.toString('hex'), grantUntil: until, grantPreimage: grant, voteContract: st.prime, voteDigest: digest.toString('hex'), votePreimage: vote, txXdr: tx.toXDR(), txHash: tx.hash().toString('hex'), latest }, null, 1));
console.log('ok', pub.stellar, latest);
