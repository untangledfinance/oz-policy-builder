// EXPERIMENTAL TESTNET ONLY. Never imports .env or existing wallet keys.
import {Address, Contract, Keypair, Networks, Operation, rpc, TransactionBuilder, xdr, nativeToScVal} from "@stellar/stellar-sdk";
import {encodePredicate} from "@crediolabs/policy-synth";
import {readFileSync,writeFileSync,existsSync,chmodSync} from "node:fs";
import {createHash} from "node:crypto";
import assert from "node:assert/strict";
import {accountEntry,authDigest,authPayload,delegatedSigner,delegatedSignerEntry,signaturePayload} from "./execution-oz-auth.ts";

const PASS=Networks.TESTNET;
const RPC="https://soroban-testnet.stellar.org";
const server=new rpc.Server(RPC);
const STATE=process.env.EXECUTOR_TESTNET_STATE??"/tmp/prime-executor-testnet-state.json";
const EVIDENCE="docs/execution-adapter-testnet-evidence.json";
const BUILD=process.env.EXECUTOR_BUILD_DIR??"target/wasm32v1-none/release";
const TOKEN="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const POOL="CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const CAP=20000000n;
let state:any=existsSync(STATE)?JSON.parse(readFileSync(STATE,"utf8")):{custody:Keypair.random().secret(),agent:Keypair.random().secret(),stranger:Keypair.random().secret(),contracts:{},rules:{},done:[],transactions:[],checks:[]};
const custody=Keypair.fromSecret(state.custody),agent=Keypair.fromSecret(state.agent),stranger=Keypair.fromSecret(state.stranger);
function save() {
 writeFileSync(STATE,JSON.stringify(state,null,2),{mode:0o600});chmodSync(STATE,0o600);
 const pub={network:"TESTNET",rpc:RPC,updatedAt:new Date().toISOString(),custody:custody.publicKey(),agent:agent.publicKey(),stranger:stranger.publicKey(),token:TOKEN,pool:POOL,contracts:state.contracts,rules:state.rules,wasmHashes:state.wasmHashes,transactions:state.transactions,checks:state.checks,done:state.done};
 writeFileSync(EVIDENCE,JSON.stringify(pub,null,2));
}
// Reject stale evidence before network calls or rewriting the public report.
for(const [name,path] of Object.entries({
 "oz-account":"contracts/policy-interpreter/tests/fixtures/multisig_account_example.wasm",
 "execution-adapter":BUILD+"/execution_adapter.wasm",
 "execution-policy":BUILD+"/execution_policy.wasm",
 "test-venue":BUILD+"/execution_test_venue.wasm",
})) {
 const recorded=state.wasmHashes?.[name];
 if(recorded) assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"),recorded,"WASM changed: use a fresh testnet state file for "+name);
}
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
   state.transactions.push(entry);save();console.log(JSON.stringify(entry));
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
async function preparePrime(signer:Keypair,contract:string,fn:string,args:xdr.ScVal[],rules:Record<string,number>,expectedDenial=false) {
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
  assert(authed.error.includes("#900"),"denial was not experimental batch policy #900: "+authed.error);
  return {denied:authed.error,contexts};
 }
 if(rpc.Api.isSimulationError(authed))throw new Error("authorized: "+diagnostic(authed)+" contexts="+JSON.stringify(contexts)+" ids="+ids.join(","));
 const prepared=rpc.assembleTransaction(tx,authed).build();prepared.sign(signer);
 return {tx:prepared,contexts};
}
const litA=(s:string)=>({kind:"literal_address",value:s});
const litS=(s:string)=>({kind:"literal_symbol",value:s});
const litI=(n:bigint)=>({kind:"literal_i128",value:n.toString()});
const arg=(n:number)=>({kind:"call_arg",index:n});
const field=(key:string)=>({kind:"call_arg_field",index:3,element:0,field:key});
const eq=(l:any,r:any)=>({op:"eq",left:l,right:r});
const and=(...children:any[])=>({op:"and",children});
function configSc(cap:bigint) {
 const prime=state.contracts.prime,ex=state.contracts.executor,fixture=state.contracts.fixture;
 const amountBounds=(leaf:any)=>[ {op:"gt",left:leaf,right:litI(0n)},{op:"lt",left:leaf,right:litI(cap)} ];
 const callPred={op:"or",children:[
  and(eq({kind:"call_contract"},litA(TOKEN)),eq({kind:"call_fn"},litS("transfer_from")),eq(arg(0),litA(prime)),eq(arg(1),litA(custody.publicKey())),eq(arg(2),litA(ex)),...amountBounds(arg(3))),
  and(eq({kind:"call_contract"},litA(POOL)),eq({kind:"call_fn"},litS("submit")),eq(arg(0),litA(prime)),eq(arg(1),litA(ex)),eq(arg(2),litA(custody.publicKey())),eq({kind:"call_arg_len",index:3},{kind:"literal_u32",value:1}),eq(field("address"),litA(TOKEN)),{op:"in",needle:field("request_type"),haystack:[{kind:"literal_u32",value:0},{kind:"literal_u32",value:1}]},...amountBounds(field("amount"))),
  and(eq({kind:"call_contract"},litA(fixture)),eq({kind:"call_fn"},litS("act")),eq(arg(0),litA(prime))),
 ]};
 const authPred=and(eq({kind:"call_contract"},litA(TOKEN)),eq({kind:"call_fn"},litS("transfer")),eq(arg(0),litA(ex)),eq(arg(1),litA(POOL)),...amountBounds(arg(2)));
 const enc=(p:any)=>xdr.ScVal.scvBytes(Buffer.from(encodePredicate(p).encodedPredicate,"base64"));
 return map({executor:addr(ex),call_predicate:enc(callPred),auth_predicate:enc(authPred),max_calls:u32(3)});
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
const act=(value:number)=>call(state.contracts.fixture,"act",[addr(state.contracts.prime),u32(value)]);
function lowRules(){return {[state.contracts.executor]:state.rules["agent-exec"],[TOKEN]:state.rules["agent-token"],[POOL]:state.rules["agent-pool"],[state.contracts.fixture]:state.rules["agent-act"]};}
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
async function snapshot(){return {custody:(await balance(custody.publicKey())).toString(),prime:(await balance(state.contracts.prime)).toString(),executor:(await balance(state.contracts.executor)).toString(),allowance:(await allowance()).toString(),position:(await position()).toString(),fixture:(await view(state.contracts.fixture,"get")).u32()};}
async function check(name:string,fn:()=>Promise<any>) {
 if(state.done.includes(name)){console.log("already verified",name);return;}
 const result=await fn();state.checks.push({name,result});state.done.push(name);save();console.log("PASS",name,JSON.stringify(result));
}
async function deny(name:string,calls:xdr.ScVal[]) {
 await check(name,async()=>{const before=await snapshot();const res:any=await preparePrime(agent,state.contracts.executor,"execute",[addr(state.contracts.prime),vec(calls)],lowRules(),true);const after=await snapshot();assert.deepEqual(after,before);return {error:res.denied,unchanged:true,contexts:res.contexts};});
}

await faucet(custody);await faucet(agent);await faucet(stranger);
const ozHash=await upload("oz-account","contracts/policy-interpreter/tests/fixtures/multisig_account_example.wasm");
await deploy("prime",ozHash,[vec([delegatedSigner(custody.publicKey())]),map({})]);
await deploy("executor",await upload("execution-adapter",BUILD+"/execution_adapter.wasm"),[addr(state.contracts.prime)]);
await deploy("policy",await upload("execution-policy",BUILD+"/execution_policy.wasm"),[]);
await deploy("fixture",await upload("test-venue",BUILD+"/execution_test_venue.wasm"),[addr(custody.publicKey())]);
await install("agent-exec",state.contracts.executor,agent,CAP);
await install("agent-token",TOKEN,agent,CAP);
await install("agent-pool",POOL,agent,CAP);
await install("agent-act",state.contracts.fixture,agent,CAP);
await install("human-exec",state.contracts.executor,custody,50000000n);
await check("initial allowance",async()=>{
 const ledger=(await server.getLatestLedger()).sequence;
 await plain(custody,TOKEN,"approve",[addr(custody.publicKey()),addr(state.contracts.prime),int(100000000n),u32(ledger+1500)],"approve custody to Prime");
 assert.equal(await allowance(),100000000n);
 assert.equal(asBig(await view(TOKEN,"allowance",[addr(custody.publicKey()),addr(state.contracts.executor)])),0n);
 return {amount:"100000000",expiresLedger:ledger+1500,executorAllowance:"0"};
});
await check("real Blend atomic supply",async()=>{
 const before=await snapshot();const r=await exec([pull(10000000n),poolCall(10000000n)],"agent atomic Blend supply");const after=await snapshot();
 assert.equal(BigInt(before.custody)-BigInt(after.custody),10000000n);
 assert.equal(BigInt(before.allowance)-BigInt(after.allowance),10000000n);
 assert.equal(after.prime,"0");assert.equal(after.executor,"0");assert(BigInt(after.position)>BigInt(before.position));
 return {before,after,contexts:r.contexts,hash:r.receipt.txHash};
});
await check("no-funding action",async()=>{
 const before=await snapshot();const r=await exec([act(7)],"agent no-funding fixture action");const after=await snapshot();
 assert.equal(after.fixture,7);assert.equal(after.custody,before.custody);assert.equal(after.allowance,before.allowance);assert.equal(after.prime,"0");assert.equal(after.executor,"0");
 return {before,after,contexts:r.contexts};
});
await check("withdraw directly to custody",async()=>{
 const before=await snapshot();await exec([poolCall(2000000n,1)],"agent Blend withdraw to custody");const after=await snapshot();
 assert.equal(BigInt(after.custody)-BigInt(before.custody),2000000n);assert.equal(after.executor,"0");assert.equal(after.prime,"0");assert.equal(after.allowance,before.allowance);
 return {before,after};
});
await deny("over-cap denial",[pull(CAP),poolCall(CAP)]);
await deny("wrong funding destination denial",[pull(1000000n,stranger.publicKey()),act(8)]);
await deny("unapproved extra call denial",[act(8),call(TOKEN,"approve",[addr(state.contracts.executor),addr(stranger.publicKey()),int(1n),u32((await server.getLatestLedger()).sequence+100)])]);
await deny("malicious executor authorization denial",[pull(1000000n),poolCall(1000000n,0,stranger.publicKey())]);
await check("different Prime rejected",async()=>{
 const first=await base(stranger,new Contract(state.contracts.executor).call("execute",addr(stranger.publicKey()),vec([act(8)])));
 const sim=await server.simulateTransaction(first);assert(rpc.Api.isSimulationError(sim));return {error:sim.error};
});
await check("human-authorized over-cap supply",async()=>{
 const before=await snapshot();await exec([pull(25000000n),poolCall(25000000n)],"human approved above agent cap",custody,{"*":0,[state.contracts.executor]:state.rules["human-exec"]});const after=await snapshot();
 assert(BigInt(after.position)>BigInt(before.position));assert.equal(BigInt(before.allowance)-BigInt(after.allowance),25000000n);assert.equal(after.executor,"0");assert.equal(after.prime,"0");
 return {before,after,note:"fresh local testnet owner key; no MetaMask/Freighter UI"};
});
await check("on-ledger late failure rollback",async()=>{
 await plain(custody,state.contracts.fixture,"set_fail",[xdr.ScVal.scvBool(false)],"fixture ready before simulation");
 const b:any=await preparePrime(agent,state.contracts.executor,"execute",[addr(state.contracts.prime),vec([pull(1000000n),act(9)])],lowRules());
 await plain(custody,state.contracts.fixture,"set_fail",[xdr.ScVal.scvBool(true)],"arm late venue failure after simulation");
 const before=await snapshot();const receipt=await submit(b.tx,"signed batch fails on ledger after pull","FAILED");const after=await snapshot();
 assert.deepEqual(after,before);
 await plain(custody,state.contracts.fixture,"set_fail",[xdr.ScVal.scvBool(false)],"reset fixture failure");
 return {before,after,ledgerFailure:true,feePayer:agent.publicKey(),contexts:b.contexts};
});
await check("allowance revocation blocks agent",async()=>{
 const ledger=(await server.getLatestLedger()).sequence;await plain(custody,TOKEN,"approve",[addr(custody.publicKey()),addr(state.contracts.prime),int(0n),u32(ledger+1)],"revoke custody allowance");
 assert.equal(await allowance(),0n);
 const tx=await base(agent,new Contract(state.contracts.executor).call("execute",addr(state.contracts.prime),vec([pull(1000000n),poolCall(1000000n)])));
 const sim=await server.simulateTransaction(tx);assert(rpc.Api.isSimulationError(sim));assert(sim.error.includes("#9"),sim.error);
 return {allowance:"0",error:sim.error};
});
save();console.log("ALL TESTNET CHECKS COMPLETED",state.done.length);
