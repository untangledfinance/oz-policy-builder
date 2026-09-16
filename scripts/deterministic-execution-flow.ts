// EXPERIMENTAL TESTNET ONLY. Never imports .env or existing wallet keys.
import {Address, Contract, Keypair, Networks, Operation, rpc, TransactionBuilder, xdr, nativeToScVal, hash, scValToNative, StrKey} from "@stellar/stellar-sdk";
import {counterfactualStellarContractId} from "./execution-counterfactual.ts";
import {encodeExecutionDocument,scopedBlendExecutionPlans} from "../packages/policy-synth/src/install/scoped-execution.ts";
import {readFileSync,writeFileSync,existsSync,chmodSync} from "node:fs";
import {createHash} from "node:crypto";
import assert from "node:assert/strict";
import {accountEntry,authDigest,authPayload,delegatedSigner,delegatedSignerEntry,signaturePayload} from "./execution-oz-auth.ts";

const PASS=Networks.TESTNET;
const RPC="https://soroban-testnet.stellar.org";
const server=new rpc.Server(RPC);
const STATE=process.env.DETERMINISTIC_EXECUTION_STATE??"/tmp/prime-deterministic-production-flow-state.json";
const EVIDENCE="docs/deterministic-execution-flow-evidence.json";
const TOKEN="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const POOL="CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const CAP=20000000n;
const ADAPTER_HASH="719240da0e3cf8a7fa32dad3a1af65c01276e4194a8ba68eef7b8a9d27126f7c";
const INTERPRETER_HASH="67bbee0914172e0c6d2cdb4038b986660265f53d7e6443f3da0453656337a15a";
const INTERPRETER="CASWUYJKTCLMMOQ5R36EEWX6GHI2TCPCTWWJTCODBQ632ODAWNWMDPZP";
if(process.argv.includes("--verify")) {await verifyPublicEvidence();process.exit(0);}
let state:any=existsSync(STATE)?JSON.parse(readFileSync(STATE,"utf8")):{custody:Keypair.random().secret(),agent:Keypair.random().secret(),stranger:Keypair.random().secret(),contracts:{},rules:{},done:[],transactions:[],checks:[]};
const custody=Keypair.fromSecret(state.custody),agent=Keypair.fromSecret(state.agent),stranger=Keypair.fromSecret(state.stranger);
function save() {
 writeFileSync(STATE,JSON.stringify(state,null,2),{mode:0o600});chmodSync(STATE,0o600);
 const pub={network:"TESTNET",rpc:RPC,updatedAt:new Date().toISOString(),custody:custody.publicKey(),agent:agent.publicKey(),stranger:stranger.publicKey(),token:TOKEN,pool:POOL,contracts:state.contracts,rules:state.rules,wasmHashes:state.wasmHashes,transactions:state.transactions,checks:state.checks,done:state.done,productionDocument:state.productionDocument,receipts:state.receipts,complete:state.complete};
 writeFileSync(EVIDENCE,JSON.stringify(pub,null,2));
}
assert(STATE.startsWith("/tmp/"),"Disposable private state must remain in /tmp");
state.wasmHashes??={};
state.wasmHashes["execution-adapter"]=ADAPTER_HASH;
state.wasmHashes["policy-interpreter"]=INTERPRETER_HASH;
if(state.contracts.policy)assert.equal(state.contracts.policy,INTERPRETER);
state.contracts.policy=INTERPRETER;
save();
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const addr=(s:string)=>new Address(s).toScVal();
const sym=(s:string)=>xdr.ScVal.scvSymbol(s);
const u32=(n:number)=>xdr.ScVal.scvU32(n);
const int=(n:bigint)=>nativeToScVal(n,{type:"i128"});
const vec=(v:xdr.ScVal[])=>xdr.ScVal.scvVec(v);
const map=(o:Record<string,xdr.ScVal>)=>xdr.ScVal.scvMap(Object.keys(o).sort().map(k=>new xdr.ScMapEntry({key:sym(k),val:o[k]!})));
function asBig(v:xdr.ScVal) {const x=v.i128();return (BigInt(x.hi().toString())<<64n)+BigInt(x.lo().toString());}

async function faucet(k:Keypair) {
 try {await server.getAccount(k.publicKey());return;} catch {}
 const response=await fetch("https://friendbot.stellar.org/?addr="+k.publicKey());
 if(!response.ok) throw new Error("friendbot "+response.status+" "+(await response.text()).slice(0,120));
 await server.getAccount(k.publicKey());
}
async function base(signer:Keypair,op:any) {
 return new TransactionBuilder(await server.getAccount(signer.publicKey()),{fee:"2000000",networkPassphrase:PASS}).addOperation(op).setTimeout(600).build();
}
async function submit(tx:any,label:string,expected="SUCCESS") {
 const sent=await server.sendTransaction(tx);
 if(sent.status==="ERROR") throw new Error(label+" send ERROR "+sent.errorResult?.toXDR("base64"));
 for(let i=0;i<80;i++){
  const receipt=await server.getTransaction(sent.hash);
  if(receipt.status==="SUCCESS"||receipt.status==="FAILED"){
   const entry={label,hash:sent.hash,status:receipt.status,ledger:receipt.ledger,resultXdr:receipt.status==="FAILED"?receipt.resultXdr?.toXDR("base64"):undefined};
   state.transactions.push(entry);state.receipts??=[];state.receipts.push(receiptRecord(receipt,label,sent.hash));save();console.log(JSON.stringify(entry));
   assert.equal(receipt.status,expected,label+" unexpected ledger status");
   return receipt;
  }
  await sleep(1500);
 }
 throw new Error(label+" timed out: "+sent.hash);
}
async function plain(signer:Keypair,contract:string,fn:string,args:xdr.ScVal[],label:string) {
 const tx=await base(signer,new Contract(contract).call(fn,...args));
 const prepared=await server.prepareTransaction(tx);prepared.sign(signer);return submit(prepared,label);
}
async function view(contract:string,fn:string,args:xdr.ScVal[]=[]) {
 const tx=await base(agent,new Contract(contract).call(fn,...args));
 const sim=await server.simulateTransaction(tx);
 if(rpc.Api.isSimulationError(sim)) throw new Error("view "+fn+" "+sim.error);
 if(!sim.result)throw new Error("empty view");
 return sim.result.retval;
}
async function upload(name:string,path:string) {
 const wasm=readFileSync(path);const hash=createHash("sha256").update(wasm).digest("hex");
 state.wasmHashes??={};state.wasmHashes[name]=hash;save();
 if(state.uploaded?.includes(hash))return hash;
 const tx=await base(custody,Operation.uploadContractWasm({wasm}));
 const prepared=await server.prepareTransaction(tx);prepared.sign(custody);await submit(prepared,"upload "+name);
 state.uploaded??=[];state.uploaded.push(hash);save();return hash;
}
async function deploy(name:string,hash:string,args:xdr.ScVal[]) {
 if(state.contracts[name])return state.contracts[name];
 const tx=await base(custody,Operation.createCustomContract({address:new Address(custody.publicKey()),wasmHash:Buffer.from(hash,"hex"),constructorArgs:args}));
 const prepared=await server.prepareTransaction(tx);prepared.sign(custody);
 const receipt:any=await submit(prepared,"deploy "+name);
 const id=Address.fromScVal(receipt.returnValue).toString();state.contracts[name]=id;save();return id;
}
function flatten(inv:any):{contract:string;method:string}[] {
 const f=inv.function().contractFn();return [{contract:Address.fromScAddress(f.contractAddress()).toString(),method:f.functionName().toString()},...inv.subInvocations().flatMap(flatten)];
}
function diagnostic(sim:any) {return sim.error+" "+JSON.stringify(sim.events??sim.diagnosticEvents??[]).slice(0,100);}
async function preparePrime(signer:Keypair,contract:string,fn:string,args:xdr.ScVal[],rules:Record<string,number>,expectedDenial:boolean|"executor-auth"=false) {
 const first=await base(signer,new Contract(contract).call(fn,...args));
 const sim=await server.simulateTransaction(first);
 if(rpc.Api.isSimulationError(sim))throw new Error("recording: "+diagnostic(sim));
 const own=(sim.result?.auth??[]).find(e=>e.credentials().switch().name==="sorobanCredentialsAddress"&&Address.fromScAddress(e.credentials().address().address()).toString()===state.contracts.prime);
 if(!own)throw new Error("no real OZ auth recorded");
 const contexts=flatten(own.rootInvocation());
 const ids=contexts.map(c=>{
  const id=rules[c.contract]??rules["*"];
  if(id===undefined)throw new Error("no rule for "+JSON.stringify(c));
  return id;
 });
 const exp=(await server.getLatestLedger()).sequence+200;
 const digest=authDigest(signaturePayload(PASS,own.credentials().address().nonce(),exp,own.rootInvocation()),ids);
 const auth=[accountEntry(own,exp,authPayload([signer.publicKey()],ids)),...ids.map(()=>delegatedSignerEntry(state.contracts.prime,digest))];
 const tx=await base(signer,Operation.invokeContractFunction({contract,function:fn,args,auth}));
 const authed=await server.simulateTransaction(tx);
 if(expectedDenial){
  assert(rpc.Api.isSimulationError(authed),"attack unexpectedly allowed by chain simulation");
  if(expectedDenial==="executor-auth") assert(authed.error.includes("Unauthorized function call for address") && authed.error.includes(state.contracts.executor),"expected executor authorization denial");
  else assert(/#900|#903/.test(authed.error),"denial was not scoped execution policy: "+authed.error);
  return {denied:authed.error,contexts};
 }
 if(rpc.Api.isSimulationError(authed))throw new Error("authorized: "+diagnostic(authed)+" contexts="+JSON.stringify(contexts)+" ids="+ids.join(","));
 const prepared=rpc.assembleTransaction(tx,authed).build();prepared.sign(signer);
 return {tx:prepared,contexts};
}
function configSc(cap:bigint) {
 const p={prime:state.contracts.prime,custody:custody.publicKey(),executor:state.contracts.executor,token:TOKEN,pool:POOL,maxAmountBaseUnits:cap.toString()};
 const plans=scopedBlendExecutionPlans(p);
 assert.equal(plans.length,2,"Only exact production supply and withdraw plans");
 const doc=encodeExecutionDocument({executor:p.executor,plans});
 state.productionDocument={...doc,parameters:p,plans};save();
 return map({grammar_version:u32(6),install_nonce:u32(1),predicate:xdr.ScVal.scvBytes(Buffer.from(doc.encodedPredicate,"base64")),predicate_hash:xdr.ScVal.scvBytes(Buffer.from(doc.predicateHash,"hex")),policy_admins:vec([delegatedSigner(custody.publicKey())])});
}

async function install(name:string,target:string,signer:Keypair,cap:bigint) {
 if(state.rules[name]!==undefined)return;
 const args=[vec([sym("CallContract"),addr(target)]),xdr.ScVal.scvString(name),xdr.ScVal.scvVoid(),vec([delegatedSigner(signer.publicKey())]),xdr.ScVal.scvMap([new xdr.ScMapEntry({key:addr(state.contracts.policy),val:configSc(cap)})])];
 const built:any=await preparePrime(custody,state.contracts.prime,"add_context_rule",args,{"*":0});
 await submit(built.tx,"install "+name);
 // IDs are read from chain, never inferred from returned call count.
 const count=(await view(state.contracts.prime,"get_context_rules_count")).u32();
 for(let id=0;id<count+5;id++){
  try{
   const raw=await view(state.contracts.prime,"get_context_rule",[u32(id)]);
   const m=new Map((raw.map()??[]).map(e=>[e.key().sym().toString(),e.val()]));
   if(m.get("name")?.str().toString()===name){state.rules[name]=id;save();return;}
  }catch{}
 }
 throw new Error("installed rule not found "+name);
}
function authTransfer(to:string,amount:bigint):xdr.ScVal {
 return vec([sym("Contract"),map({context:map({contract:addr(TOKEN),fn_name:sym("transfer"),args:vec([addr(state.contracts.executor),addr(to),int(amount)])}),sub_invocations:vec([])})]);
}
function call(target:string,fn:string,args:xdr.ScVal[],auth:xdr.ScVal[]=[]):xdr.ScVal {
 return map({target:addr(target),function_name:sym(fn),args:vec(args),executor_authorizations:vec(auth)});
}
function pull(amount:bigint,to=state.contracts.executor) {return call(TOKEN,"transfer_from",[addr(state.contracts.prime),addr(custody.publicKey()),addr(to),int(amount)]);}
function poolCall(amount:bigint,type=0,authDest=POOL) {
 const request=map({address:addr(TOKEN),amount:int(amount),request_type:u32(type)});
 return call(POOL,"submit",[addr(state.contracts.prime),addr(state.contracts.executor),addr(custody.publicKey()),vec([request])],type===0?[authTransfer(POOL,amount),...(authDest===POOL?[]:[authTransfer(authDest,amount)])]:[]);
}
function lowRules(){return {[state.contracts.executor]:state.rules["agent-exec"],[TOKEN]:state.rules["agent-token"],[POOL]:state.rules["agent-pool"]};}
async function exec(calls:xdr.ScVal[],label:string,signer=agent,rules=lowRules()) {
 const b:any=await preparePrime(signer,state.contracts.executor,"execute",[addr(state.contracts.prime),vec(calls)],rules);
 const receipt=await submit(b.tx,label);return {receipt,contexts:b.contexts};
}
async function balance(who:string){return asBig(await view(TOKEN,"balance",[addr(who)]));}
async function allowance(){return asBig(await view(TOKEN,"allowance",[addr(custody.publicKey()),addr(state.contracts.prime)]));}
async function position() {
 const raw=await view(POOL,"get_positions",[addr(state.contracts.prime)]);
 const m=new Map((raw.map()??[]).map(e=>[e.key().sym().toString(),e.val()]));
 const entries=m.get("supply")?.map()??[];return entries.reduce((sum,e)=>sum+asBig(e.val()),0n);
}
async function snapshot(){return {scopeActive:(await view(state.contracts.policy,"execution_active",[addr(state.contracts.executor)])).b(),custody:(await balance(custody.publicKey())).toString(),prime:(await balance(state.contracts.prime)).toString(),executor:(await balance(state.contracts.executor)).toString(),allowance:(await allowance()).toString(),position:(await position()).toString()};}
async function check(name:string,fn:()=>Promise<any>) {
 if(state.done.includes(name)){console.log("already verified",name);return;}
 const result=await fn();state.checks.push({name,result});state.done.push(name);save();console.log("PASS",name,JSON.stringify(result));
}
async function deny(name:string,calls:xdr.ScVal[]) {
 await check(name,async()=>{const before=await snapshot();const res:any=await preparePrime(agent,state.contracts.executor,"execute",[addr(state.contracts.prime),vec(calls)],lowRules(),true);const after=await snapshot();assert.deepEqual(after,before);return {error:res.denied,unchanged:true,contexts:res.contexts};});
}


function normalize(v:any):any {return typeof v==="bigint"?v.toString():Array.isArray(v)?v.map(normalize):v;}
function receiptRecord(r:any,label:string,hash:string) {
 const events=(r.events?.contractEventsXdr??[]).flat().map((event:any)=>({
  contract:event.contractId()?Address.contract(event.contractId()).toString():null,
  topics:event.body().v0().topics().map((v:any)=>normalize(scValToNative(v))),
  data:normalize(scValToNative(event.body().v0().data()))
 }));
 return {label,hash,status:r.status,ledger:r.ledger,events,
  envelopeXdr:r.envelopeXdr?.toXDR("base64"),resultXdr:r.resultXdr?.toXDR("base64"),
  resultMetaXdr:r.resultMetaXdr?.toXDR("base64"),
  diagnosticEventsXdr:r.diagnosticEventsXdr?.map((e:any)=>e.toXDR("base64"))};
}
async function instance(id:string) {
 const key=xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({contract:new Address(id).toScAddress(),key:xdr.ScVal.scvLedgerKeyContractInstance(),durability:xdr.ContractDataDurability.persistent()}));
 const response=await server.getLedgerEntries(key);
 if(!response.entries.length)return null;
 const value=response.entries[0]!.val.contractData().val().instance();
 const binding=(name:string)=>{const e=value.storage()?.find(e=>e.key().switch().name==="scvSymbol"&&e.key().sym().toString()===name);return e?Address.fromScVal(e.val()).toString():null;};
 return {address:id,wasmHash:value.executable().wasmHash().toString("hex"),primeBinding:binding("prime"),interpreterBinding:binding("interpreter"),observedLedger:response.latestLedger,entryXdr:response.entries[0]!.val.toXDR("base64")};
}
function tokenTransfers(r:any) {
 return receiptRecord(r,"","").events.filter((e:any)=>e.contract===TOKEN&&e.topics[0]==="transfer").map((e:any)=>[e.topics[1],e.topics[2],e.data]);
}
async function activate() {
 const prime=state.contracts.prime,salt=hash(Buffer.from("prime-execution:v2"));
 const predicted=await counterfactualStellarContractId({deployer:prime,salt,networkPassphrase:PASS});
 if(state.contracts.executor)assert.equal(state.contracts.executor,predicted);
 const create=(auth:xdr.SorobanAuthorizationEntry[]=[])=>Operation.createCustomContract({address:new Address(prime),salt,wasmHash:Buffer.from(ADAPTER_HASH,"hex"),constructorArgs:[addr(prime),addr(INTERPRETER)],auth});
 if(!state.contracts.executor) {
  assert.equal(await instance(predicted),null,"Unknown prior activation at expected address");
  const sim=await server.simulateTransaction(await base(custody,create()));
  assert(!rpc.Api.isSimulationError(sim),"activation recording failed: "+(sim as any).error);
  const own=sim.result?.auth?.find(e=>e.credentials().switch().name==="sorobanCredentialsAddress"&&Address.fromScAddress(e.credentials().address().address()).toString()===prime);
  assert(own,"missing Prime authorization");
  assert.equal(own.rootInvocation().function().switch().name,"sorobanAuthorizedFunctionTypeCreateContractV2HostFn");
  assert.equal(own.rootInvocation().subInvocations().length,0);
  assert.equal(Address.fromScVal(sim.result!.retval).toString(),predicted);
  const expiration=(await server.getLatestLedger()).sequence+200;
  const digest=authDigest(signaturePayload(PASS,own.credentials().address().nonce(),expiration,own.rootInvocation()),[0]);
  const auth=[accountEntry(own,expiration,authPayload([custody.publicKey()],[0])),delegatedSignerEntry(prime,digest)];
  const tx=await base(custody,create(auth)),authorized=await server.simulateTransaction(tx);
  assert(!rpc.Api.isSimulationError(authorized),"Prime-authorized activation failed: "+(authorized as any).error);
  const inner=rpc.assembleTransaction(tx,authorized as any).build();inner.sign(custody);
  const sponsored=TransactionBuilder.buildFeeBumpTransaction(agent.publicKey(),inner.fee,inner,PASS);sponsored.sign(agent);
  const receipt:any=await submit(sponsored,"Prime-owned deterministic CreateContractV2");
  assert.equal(Address.fromScVal(receipt.returnValue).toString(),predicted);
  const op=receipt.envelopeXdr.feeBump().tx().innerTx().v1().tx().operations()[0].body().invokeHostFunctionOp();
  const actual=op.hostFunction().createContractV2();
  assert.equal(Address.fromScAddress(actual.contractIdPreimage().fromAddress().address()).toString(),prime);
  assert.equal(actual.contractIdPreimage().fromAddress().salt().toString("hex"),salt.toString("hex"));
  assert.equal(actual.executable().wasmHash().toString("hex"),ADAPTER_HASH);
  assert.deepEqual(actual.constructorArgs().map((v:any)=>Address.fromScVal(v).toString()),[prime,INTERPRETER]);
  state.contracts.executor=predicted;save();
 }
 await check("deterministic address and exact immutable bindings",async()=>{
  const adapter=await instance(predicted);assert(adapter);
  assert.equal(adapter.wasmHash,ADAPTER_HASH);assert.equal(adapter.primeBinding,prime);assert.equal(adapter.interpreterBinding,INTERPRETER);
  return {saltLabel:"prime-execution:v2",saltHex:salt.toString("hex"),deployer:prime,adapter};
 });
}

await faucet(custody);await faucet(agent);await faucet(stranger);
await check("deployed production interpreter and adapter artifact pins",async()=>{
 const interpreter=await instance(INTERPRETER);assert(interpreter);assert.equal(interpreter.wasmHash,INTERPRETER_HASH);
 const code=await server.getLedgerEntries(xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({hash:Buffer.from(ADAPTER_HASH,"hex")})));
 assert.equal(code.entries.length,1);
 assert.equal(createHash("sha256").update(code.entries[0]!.val.contractCode().code()).digest("hex"),ADAPTER_HASH);
 return {interpreter,adapterCodeHash:ADAPTER_HASH,adapterCodeBytes:code.entries[0]!.val.contractCode().code().length,observedLedger:code.latestLedger};
});
const ozHash=await upload("oz-account","contracts/policy-interpreter/tests/fixtures/multisig_account_example.wasm");
await deploy("prime",ozHash,[vec([delegatedSigner(custody.publicKey())]),map({})]);
await check("fresh actual OZ Prime",async()=>{const p=await instance(state.contracts.prime);assert(p);assert.equal(p.wasmHash,ozHash);assert.equal((await view(state.contracts.prime,"get_context_rules_count")).u32(),1);return p;});
await activate();
await install("agent-exec",state.contracts.executor,agent,CAP);
await install("agent-token",TOKEN,agent,CAP);
await install("agent-pool",POOL,agent,CAP);
await check("only owner plus production scoped Blend rules installed",async()=>{
 assert.equal((await view(state.contracts.prime,"get_context_rules_count")).u32(),4);
 assert.equal(state.productionDocument.plans.length,2);
 const rules=[];
 for(let id=0;id<4;id++)rules.push({id,ruleXdr:(await view(state.contracts.prime,"get_context_rule",[u32(id)])).toXDR("base64")});
 return {rules,productionPlanCount:2,fixturePlans:false,predicateHash:state.productionDocument.predicateHash};
});
try {
 if(!state.complete) {
 await check("custody allowance only to Prime",async()=>{
  const ledger=(await server.getLatestLedger()).sequence;
  await plain(custody,TOKEN,"approve",[addr(custody.publicKey()),addr(state.contracts.prime),int(15000000n),u32(ledger+1500)],"approve disposable custody to Prime");
  assert.equal(await allowance(),15000000n);
  assert.equal(asBig(await view(TOKEN,"allowance",[addr(custody.publicKey()),addr(state.contracts.executor)])),0n);
  return {allowance:"15000000",adapterAllowance:"0"};
 });
 await check("production supply through deterministic adapter",async()=>{
  const before=await snapshot();const r=await exec([pull(10000000n),poolCall(10000000n)],"deterministic production Blend supply");const after=await snapshot();
  assert.equal(BigInt(before.custody)-BigInt(after.custody),10000000n);assert.equal(BigInt(before.allowance)-BigInt(after.allowance),10000000n);
  assert.equal(after.scopeActive,false);assert.equal(after.prime,"0");assert.equal(after.executor,"0");assert(BigInt(after.position)>BigInt(before.position));
  assert.deepEqual(tokenTransfers(r.receipt),[[custody.publicKey(),state.contracts.executor,"10000000"],[state.contracts.executor,POOL,"10000000"]]);
  return {before,after,contexts:r.contexts,transfers:tokenTransfers(r.receipt)};
 });
 await check("production withdrawal through same deterministic adapter",async()=>{
  const before=await snapshot();const r=await exec([poolCall(2000000n,1)],"deterministic production Blend withdraw");const after=await snapshot();
  assert.equal(BigInt(after.custody)-BigInt(before.custody),2000000n);assert.equal(after.allowance,before.allowance);
  assert.equal(after.scopeActive,false);assert.equal(after.prime,"0");assert.equal(after.executor,"0");assert(BigInt(after.position)<BigInt(before.position));assert(BigInt(after.position)>0n);
  assert.deepEqual(tokenTransfers(r.receipt),[[POOL,custody.publicKey(),"2000000"]]);
  return {before,after,contexts:r.contexts,transfers:tokenTransfers(r.receipt),retainedPositionIntentional:true};
 });
 await deny("production pull-only batch denied",[pull(1000000n)]);
 await deny("production unequal pull and supply denied",[pull(1000000n),poolCall(500000n)]);
 await check("standalone transfer_from denied with production token rule",async()=>{
  const before=await snapshot();
  const result:any=await preparePrime(agent,TOKEN,"transfer_from",[addr(state.contracts.prime),addr(custody.publicKey()),addr(state.contracts.executor),int(1000000n)],{"*":state.rules["agent-token"]},true);
  assert.deepEqual(await snapshot(),before);return {error:result.denied,contexts:result.contexts,unchanged:true};
 });
 }
} finally {
 if(await allowance()!==0n) {
  const ledger=(await server.getLatestLedger()).sequence;
  await plain(custody,TOKEN,"approve",[addr(custody.publicKey()),addr(state.contracts.prime),int(0n),u32(ledger+1)],"final revoke disposable custody allowance");
 }
 assert.equal(await allowance(),0n);
}
await check("final cleanup and fresh funding blocked",async()=>{
 const final=await snapshot();assert.equal(final.allowance,"0");assert.equal(final.executor,"0");assert.equal(final.prime,"0");assert.equal(final.scopeActive,false);
 const sim=await server.simulateTransaction(await base(agent,new Contract(state.contracts.executor).call("execute",addr(state.contracts.prime),vec([pull(1000000n),poolCall(1000000n)]))));
 assert(rpc.Api.isSimulationError(sim));assert(sim.error.includes("#9"),sim.error);
 return {final,error:sim.error,retainedBlendPosition:"Intentional remaining supplied position after partial withdrawal"};
});
state.complete=true;save();console.log("DETERMINISTIC PRODUCTION FLOW VERIFIED",state.done.length,"checks",state.contracts.executor);

async function verifyPublicEvidence() {
 const e=JSON.parse(readFileSync(EVIDENCE,"utf8"));
 assert.equal(e.network,"TESTNET");assert.equal(e.complete,true);assert.equal(e.contracts.policy,INTERPRETER);
 assert.equal(e.wasmHashes["execution-adapter"],ADAPTER_HASH);assert.equal(e.wasmHashes["policy-interpreter"],INTERPRETER_HASH);
 const predicted=await counterfactualStellarContractId({deployer:e.contracts.prime,salt:hash(Buffer.from("prime-execution:v2")),networkPassphrase:PASS});
 assert.equal(e.contracts.executor,predicted);
 const instances=[];
 for(const [name,expected] of Object.entries({prime:e.wasmHashes["oz-account"],executor:ADAPTER_HASH,policy:INTERPRETER_HASH})) {
  const actual=await instance(e.contracts[name]);assert(actual);assert.equal(actual.wasmHash,expected);
  if(name==="executor"){assert.equal(actual.primeBinding,e.contracts.prime);assert.equal(actual.interpreterBinding,INTERPRETER);}
  instances.push(actual);
 }
 const expectedDoc=encodeExecutionDocument({executor:e.contracts.executor,plans:scopedBlendExecutionPlans(e.productionDocument.parameters)});
 assert.equal(e.productionDocument.encodedPredicate,expectedDoc.encodedPredicate);
 assert.equal(e.productionDocument.predicateHash,expectedDoc.predicateHash);
 assert.equal(e.productionDocument.plans.length,2);
 const verified=[];
 const historicalRules:any[]=[];
 for(const label of ["Prime-owned deterministic CreateContractV2","install agent-exec","install agent-token","install agent-pool","deterministic production Blend supply","deterministic production Blend withdraw","final revoke disposable custody allowance"]) {
  const recorded=e.transactions.find((t:any)=>t.label===label);assert(recorded);
  const r:any=await server.getTransaction(recorded.hash);assert.equal(r.status,"SUCCESS","missing or unsuccessful receipt: "+label);assert.equal(r.ledger,recorded.ledger);
  assert.equal(TransactionBuilder.fromXDR(r.envelopeXdr.toXDR("base64"),PASS).hash().toString("hex"),recorded.hash,"receipt envelope hash mismatch: "+label);
  if(label==="Prime-owned deterministic CreateContractV2"){
   const fb=r.envelopeXdr.feeBump().tx(),inner=fb.innerTx().v1().tx();
   assert.equal(StrKey.encodeEd25519PublicKey(fb.feeSource().ed25519()),e.agent);
   assert.equal(StrKey.encodeEd25519PublicKey(inner.sourceAccount().ed25519()),e.custody);
   const op=inner.operations()[0].body().invokeHostFunctionOp(),create=op.hostFunction().createContractV2();
   assert.equal(Address.fromScAddress(create.contractIdPreimage().fromAddress().address()).toString(),e.contracts.prime);
   assert.equal(create.contractIdPreimage().fromAddress().salt().toString("hex"),hash(Buffer.from("prime-execution:v2")).toString("hex"));
   assert.equal(create.executable().wasmHash().toString("hex"),ADAPTER_HASH);
   assert.deepEqual(create.constructorArgs().map((v:any)=>Address.fromScVal(v).toString()),[e.contracts.prime,INTERPRETER]);
   assert.equal(Address.fromScVal(r.returnValue).toString(),predicted);
   assert(op.auth().some((a:any)=>a.credentials().switch().name==="sorobanCredentialsAddress"&&Address.fromScAddress(a.credentials().address().address()).toString()===e.contracts.prime&&a.rootInvocation().function().switch().name==="sorobanAuthorizedFunctionTypeCreateContractV2HostFn"));
  } else if(label.startsWith("install agent-")) {
   // Historical installation evidence survives deliberate later rule removal.
   // The receipt, not the current mutable Doc storage, proves these exact bytes.
   const transaction=r.envelopeXdr.v1().tx();
   assert.equal(StrKey.encodeEd25519PublicKey(transaction.sourceAccount().ed25519()),e.custody);
   const op=transaction.operations()[0].body().invokeHostFunctionOp();
   const invoke=op.hostFunction().invokeContract();
   assert.equal(Address.fromScAddress(invoke.contractAddress()).toString(),e.contracts.prime);
   assert.equal(invoke.functionName().toString(),"add_context_rule");
   const args=invoke.args();assert.equal(args.length,5);
   const name=label.slice("install ".length);
   const expectedScope=name==="agent-exec"?predicted:name==="agent-token"?TOKEN:POOL;
   const context=args[0].vec();assert.equal(context.length,2);
   assert.equal(context[0].sym().toString(),"CallContract");
   assert.equal(Address.fromScVal(context[1]).toString(),expectedScope);
   assert.equal(args[1].str().toString(),name);
   assert.equal(args[2].switch().name,"scvVoid");
   assert.deepEqual(scValToNative(args[3]),[["Delegated",e.agent]]);
   const policies=args[4].map();assert.equal(policies.length,1);
   assert.equal(Address.fromScVal(policies[0].key()).toString(),INTERPRETER);
   const params=new Map(policies[0].val().map().map((entry:any)=>[entry.key().sym().toString(),entry.val()]));
   assert.equal(params.size,5);
   assert.equal((params.get("grammar_version") as xdr.ScVal).u32(),6);
   assert.equal((params.get("install_nonce") as xdr.ScVal).u32(),1);
   assert.equal((params.get("predicate") as xdr.ScVal).bytes().toString("base64"),expectedDoc.encodedPredicate);
   assert.equal((params.get("predicate_hash") as xdr.ScVal).bytes().toString("hex"),expectedDoc.predicateHash);
   assert.deepEqual(scValToNative(params.get("policy_admins") as xdr.ScVal),[["Delegated",e.custody]]);
   const result=new Map(r.returnValue.map().map((entry:any)=>[entry.key().sym().toString(),entry.val()]));
   const ruleId=(result.get("id") as xdr.ScVal).u32();assert.equal(ruleId,e.rules[name]);
   historicalRules.push({ruleId,name,scope:expectedScope,operator:e.agent,policyAdmin:e.custody,grammarVersion:6,installNonce:1,predicateHash:expectedDoc.predicateHash,installationHash:recorded.hash,installationLedger:r.ledger});
  } else if(label.includes("Blend")) {
   const invoke=r.envelopeXdr.v1().tx().operations()[0].body().invokeHostFunctionOp().hostFunction().invokeContract();
   assert.equal(Address.fromScAddress(invoke.contractAddress()).toString(),predicted);
   assert.equal(invoke.functionName().toString(),"execute");
   if(label.endsWith("supply"))assert.deepEqual(tokenTransfers(r),[[e.custody,predicted,"10000000"],[predicted,POOL,"10000000"]]);
   else assert.deepEqual(tokenTransfers(r),[[POOL,e.custody,"2000000"]]);
  }
  verified.push(receiptRecord(r,label,recorded.hash));
 }
 const read=async(contract:string,fn:string,args:xdr.ScVal[])=>{
  const tx=new TransactionBuilder(await server.getAccount(e.agent),{fee:"2000000",networkPassphrase:PASS}).addOperation(new Contract(contract).call(fn,...args)).setTimeout(600).build();
  const sim=await server.simulateTransaction(tx);assert(!rpc.Api.isSimulationError(sim));assert(sim.result);return sim.result.retval;
 };
 const address=(s:string)=>new Address(s).toScVal();
 assert.equal(asBig(await read(TOKEN,"balance",[address(predicted)])),0n);
 assert.equal(asBig(await read(TOKEN,"balance",[address(e.contracts.prime)])),0n);
 assert.equal(asBig(await read(TOKEN,"allowance",[address(e.custody),address(e.contracts.prime)])),0n);
 assert.equal((await read(INTERPRETER,"execution_active",[address(predicted)])).b(),false);
 const currentRuleCount=(await read(e.contracts.prime,"get_context_rules_count",[])).u32();
 const report={historicalAuthorityProof:"Original production document verified from immutable installation receipts; current rules may have been intentionally replaced by the app migration verification.",historicalRules,currentRuleCount,appMigrationEvidence:"/home/ubuntu/work/octopos-scoped-execution/docs/execution-install-app-testnet.json",network:"TESTNET",verifiedAt:new Date().toISOString(),predictedAddress:predicted,productionPredicateHash:expectedDoc.predicateHash,instances,receipts:verified,final:{primeBalance:"0",adapterBalance:"0",allowance:"0",scopeActive:false}};
 writeFileSync("docs/deterministic-execution-flow-verification.json",JSON.stringify(report,null,2));
 console.log("READ-ONLY VERIFICATION PASSED",JSON.stringify({predicted,receipts:verified.map((r:any)=>({label:r.label,hash:r.hash,ledger:r.ledger})),final:report.final}));
}
