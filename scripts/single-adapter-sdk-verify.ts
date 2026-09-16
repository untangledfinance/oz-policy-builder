// Read-only SDK cross-check against actual testnet activation; no wallet keys.
import * as Stellar from "@stellar/stellar-sdk";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const sdkPath=process.env.PRIME_SCOPED_SDK??"/home/ubuntu/work/prime-sdk-scoped";
const {inspectExecutionAdapter,sorobanInstanceReader,buildActivationOperation,EXECUTION_ADAPTER_MANIFEST_V2_TESTNET:manifest}=await import(sdkPath+"/src/execution-adapter/index.ts");
const evidence=JSON.parse(readFileSync("docs/single-adapter-activation-evidence.json","utf8"));
const server=new Stellar.rpc.Server("https://soroban-testnet.stellar.org");
const verdict=await inspectExecutionAdapter({prime:evidence.prime,networkPassphrase:Stellar.Networks.TESTNET,manifest,reader:sorobanInstanceReader(server,Stellar,manifest)});
assert.equal(verdict.state,"ready");
assert.equal(verdict.address,evidence.predictedAddress);
const receipt:any=await server.getTransaction(evidence.pendingHash);
assert.equal(receipt.status,"SUCCESS");
const actual=receipt.envelopeXdr.feeBump().tx().innerTx().v1().tx().operations()[0].body().invokeHostFunctionOp().hostFunction().createContractV2();
const expected=buildActivationOperation(evidence.prime,manifest).body().invokeHostFunctionOp().hostFunction().createContractV2();
assert.equal(expected.toXDR("base64"),actual.toXDR("base64"));
console.log("VERIFIED SDK v2 activation bytes + address + Prime binding + interpreter binding + both WASM hashes",JSON.stringify(verdict));
