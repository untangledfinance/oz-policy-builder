// Read-only verification of public testnet evidence. No wallet keys needed.
import {Address,rpc,scValToNative,xdr} from "@stellar/stellar-sdk";
import {readFileSync,writeFileSync} from "node:fs";
import assert from "node:assert/strict";
const evidence=JSON.parse(readFileSync("docs/single-adapter-testnet-evidence.json","utf8"));
assert.equal(evidence.network,"TESTNET");
const server=new rpc.Server("https://soroban-testnet.stellar.org");
const labels=["agent atomic Blend supply","agent no-funding fixture action","agent Blend withdraw to custody","human approved above agent cap","signed batch fails on ledger after pull"];
const records:any[]=[];
const normalize=(v:any):any=>typeof v==="bigint"?v.toString():Array.isArray(v)?v.map(normalize):v;
for(const label of labels) {
 const original=evidence.transactions.find((x:any)=>x.label===label);
 assert(original,"missing transaction: "+label);
 const r:any=await server.getTransaction(original.hash);
 assert.equal(r.status,original.status);assert.equal(r.ledger,original.ledger);
 const events=(r.events?.contractEventsXdr??[]).flat().map((event:any)=>({
  contract:event.contractId()?Address.contract(event.contractId()).toString():null,
  topics:event.body().v0().topics().map((v:any)=>normalize(scValToNative(v))),
  data:normalize(scValToNative(event.body().v0().data()))
 }));
 const transfers=events.filter((e:any)=>e.contract===evidence.token&&e.topics[0]==="transfer");
 if(label==="agent atomic Blend supply"||label==="human approved above agent cap") {
  const amount=label==="agent atomic Blend supply"?"10000000":"25000000";
  assert.deepEqual(transfers.map((e:any)=>[e.topics[1],e.topics[2],e.data]),[
   [evidence.custody,evidence.contracts.executor,amount],
   [evidence.contracts.executor,evidence.pool,amount]
  ],"token event path differs from custody -> executor -> Blend");
 }
 if(label==="agent Blend withdraw to custody") {
  assert.deepEqual(transfers.map((e:any)=>[e.topics[1],e.topics[2],e.data]),[[evidence.pool,evidence.custody,"2000000"]]);
 }
 if(label==="agent no-funding fixture action")assert.equal(transfers.length,0);
 const diagnostics=(r.diagnosticEventsXdr??[]).map((d:any)=>({
  contract:d.event().contractId()?Address.contract(d.event().contractId()).toString():null,
  inSuccessfulContractCall:d.inSuccessfulContractCall(),
  topics:d.event().body().v0().topics().map((v:any)=>normalize(scValToNative(v))),
  data:normalize(scValToNative(d.event().body().v0().data()))
 }));
 const resultCode=r.resultXdr.result().switch().name;
 let operationCode:string|undefined;
 if(r.status==="FAILED") {
  assert.equal(resultCode,"txFailed");
  const inner=r.resultXdr.result().results()[0].tr();
  operationCode=inner.invokeHostFunctionResult().switch().name;
  assert.equal(operationCode,"invokeHostFunctionTrapped");
  assert.equal(events.length,0,"failed contract emitted committed events");
  const pullDone=diagnostics.findIndex((d:any)=>d.contract===evidence.token&&d.topics[0]==="fn_return"&&d.topics[1]==="transfer_from");
  const venueFailure=diagnostics.findIndex((d:any)=>d.contract===evidence.contracts.fixture&&d.topics[0]==="error"&&JSON.stringify(d.data).includes("UnreachableCodeReached"));
  assert(pullDone>=0&&venueFailure>pullDone,"missing proof that venue failed AFTER token pull");
 }
 records.push({label,hash:original.hash,status:r.status,ledger:r.ledger,resultCode,operationCode,events,diagnostics,
  envelopeXdr:r.envelopeXdr.toXDR("base64"),resultXdr:r.resultXdr.toXDR("base64"),resultMetaXdr:r.resultMetaXdr.toXDR("base64"),
  diagnosticEventsXdr:r.diagnosticEventsXdr?.map((e:any)=>e.toXDR("base64"))});
 console.log("VERIFIED RECEIPT",label,r.status,JSON.stringify(transfers));
}
const deployedWasmProofs=[];
for(const [name,artifact] of Object.entries({prime:"oz-account",executor:"execution-adapter",policy:"policy-interpreter",fixture:"test-venue"})) {
 const contract=evidence.contracts[name];
 const key=xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({contract:new Address(contract).toScAddress(),key:xdr.ScVal.scvLedgerKeyContractInstance(),durability:xdr.ContractDataDurability.persistent()}));
 const response=await server.getLedgerEntries(key);
 assert.equal(response.entries.length,1,"missing deployed instance "+name);
 const hash=response.entries[0]!.val.contractData().val().instance().executable().wasmHash().toString("hex");
 assert.equal(hash,evidence.wasmHashes[artifact],"deployed bytecode mismatch "+name);
 deployedWasmProofs.push({name,contract,wasmHash:hash,observedLedger:response.latestLedger});
 console.log("VERIFIED DEPLOYED WASM",name,hash);
}
writeFileSync("docs/single-adapter-testnet-receipts.json",JSON.stringify({network:"TESTNET",verifiedAt:new Date().toISOString(),records,deployedWasmProofs},(_key,value)=>typeof value==="bigint"?value.toString():value,2));
