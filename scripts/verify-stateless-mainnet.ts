/**
 * Dedicated stateless v5 mainnet proof. Read-only unless --execute --fee-cap-xlm 10.
 * At most 0.01 XLM deposited at once; total fees + principal bounded to 10 XLM.
 * Owner envelopes signed by Stellar CLI. Existing agent key signs auth in memory only.
 * This proves Soroban authorization, not Freighter/MetaMask browser integration.
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { Account, Address, Asset, Contract, Keypair, Networks, Operation, TransactionBuilder, StrKey, authorizeEntry, hash, nativeToScVal, rpc, scValToNative, xdr } from '@stellar/stellar-sdk'
import { encodePredicate } from '../packages/policy-synth/src/predicate/encode.ts'
import { buildExecutionBatchPolicy, projectExecutionRequest } from '../packages/policy-synth/src/install/execution-batch.ts'
import { accountEntry, authDigest, authPayload, delegatedSigner, delegatedSignerEntry, signaturePayload } from './execution-oz-auth.ts'
const PASS=Networks.PUBLIC, RPC='https://mainnet.sorobanrpc.com', HORIZON='https://horizon.stellar.org'
const OWNER='GCIVG2AIEWMDA43HX2HRCYVNY7PH7HMPYVN42LQ5XBSHBLHFUWG47NFN'
const AGENT='GCTI2WE25C3Z4CUQXKT6RSAC4NS7M7BBVLR5PM7VS6OKYQPOABLJSMXE'
const INTERPRETER='CDIMIQDB6ZL6Q3TJM24HC3SU3YIKDNL2LB2GXHHVVCI4BRNHYDZGXEEW'
const INTERPRETER_HASH='cc05ac55747d2472f6da1fc229a2f9f8083607ba8c08bf5eaeac7cd73ef6fb66'
const ADAPTER_HASH='57bf132b9537f0d35b9de4327e047f920938eac655e7d140c108e84da3b03474'
const OZ_HASH='91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9'
const POOL='CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD'
const FACTORY='CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU'
const FACTORY_HASH='31328050548831f63d2b72e37bcfd0bb7371b7907135755dbe09ed434d755ca9'
const POOL_HASH='a41fc53d6753b6c04eb15b021c55052366a4c8e0e21bc72700f461264ec1350e'
const REGISTRY='https://raw.githubusercontent.com/blend-capital/blend-utils/main/mainnet.contracts.json'
const TOKEN=Asset.native().contractId(PASS), AMOUNT=50_000n, CAP=100_000n, ALL=(1n<<127n)-1n, TOTAL_CAP=100_000_000n
const args=process.argv.slice(2), execute=args.includes('--execute')
assert(args.every(x=>['--execute','--fee-cap-xlm','10','--agent-source-prepare','--agent-source-cleanup'].includes(x)),'Unsupported argument')
if(execute)assert(args[args.indexOf('--fee-cap-xlm')+1]==='10','Requires --fee-cap-xlm 10')
const rawServer=new rpc.Server(RPC), EVIDENCE='docs/stateless-mainnet-verification.json'
let lastRpcAt=0
// Public RPC rate limits must not turn transport failures into policy-denial evidence.
const server=new Proxy(rawServer,{get(target,name){
 const member=(target as any)[name];if(typeof member!=='function')return member
 return async(...args:any[])=>{
  for(let attempt=0;attempt<5;attempt++){
   await new Promise(r=>setTimeout(r,Math.max(0,1500-(Date.now()-lastRpcAt))));lastRpcAt=Date.now()
   try{return await member.apply(target,args)}catch(error:any){
    if(error?.response?.status!==429||attempt===4)throw error
    console.log('RPC rate limit; retrying read/request after backoff')
    await new Promise(r=>setTimeout(r,20000*(attempt+1)))
   }
  }
 }
}}) as rpc.Server
const addr=(s:string)=>new Address(s).toScVal(), sym=(s:string)=>xdr.ScVal.scvSymbol(s), u32=(n:number)=>xdr.ScVal.scvU32(n)
const int=(n:bigint)=>nativeToScVal(n,{type:'i128'}), vec=(xs:xdr.ScVal[])=>xdr.ScVal.scvVec(xs)
const map=(m:Record<string,xdr.ScVal>)=>xdr.ScVal.scvMap(Object.keys(m).sort().map(k=>new xdr.ScMapEntry({key:sym(k),val:m[k]!})))
const fields=(v:xdr.ScVal)=>new Map((v.map()??[]).map(e=>[e.key().sym().toString(),e.val()]))
const big=(v:xdr.ScVal)=>BigInt(scValToNative(v))
function derive(deployer:string,salt:Buffer){
 const p=xdr.HashIdPreimage.envelopeTypeContractId(new xdr.HashIdPreimageContractId({networkId:hash(Buffer.from(PASS)),contractIdPreimage:xdr.ContractIdPreimage.contractIdPreimageFromAddress(new xdr.ContractIdPreimageFromAddress({address:new Address(deployer).toScAddress(),salt}))}))
 return StrKey.encodeContract(hash(p.toXDR()))
}
const primeSalt=hash(Buffer.from('prime-stateless-mainnet-verification:2026-09-16:v1'))
const prime=derive(OWNER,primeSalt), salt=hash(Buffer.from('prime.execution.adapter.v1')), adapter=derive(prime,salt)
const state:any=existsSync(EVIDENCE)?JSON.parse(readFileSync(EVIDENCE,'utf8')):{
 network:PASS,rpc:RPC,owner:OWNER,agent:AGENT,contracts:{prime,adapter,interpreter:INTERPRETER},
 wasmHashes:{prime:OZ_HASH,adapter:ADAPTER_HASH,interpreter:INTERPRETER_HASH},
 token:TOKEN,pool:POOL,feeAndPrincipalCapStroops:TOTAL_CAP.toString(),maximumConcurrentPrincipalStroops:CAP.toString(),
 rules:{},bound:[],transactions:[],checks:[],
}
assert.equal(state.network,PASS);assert.equal(state.contracts.prime,prime);assert.equal(state.contracts.interpreter,INTERPRETER)
const save=()=>writeFileSync(EVIDENCE,JSON.stringify(state,(_k,v)=>typeof v==='bigint'?v.toString():v,2)+'\n')
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms))
const done=(label:string)=>state.transactions.find((t:any)=>t.label===label&&t.status==='SUCCESS')
const spent=()=>state.transactions.reduce((n:bigint,t:any)=>n+(t.status==='SUCCESS'||t.status==='FAILED'?BigInt(t.chargedFeeStroops??t.maxFeeStroops):0n),0n)
function financialSummary(){
 let deposits=0n,withdrawals=0n
 for(const t of state.transactions)for(const e of t.events??[]){
  if(e.contract!==TOKEN||e.topics?.[0]!=='transfer')continue
  if(e.topics[1]===OWNER&&e.topics[2]===adapter)deposits+=BigInt(e.data)
  if(e.topics[1]===POOL&&e.topics[2]===OWNER)withdrawals+=BigInt(e.data)
 }
 assert(withdrawals>=deposits-3n,'Unexpected principal shortfall')
 return {depositedStroops:deposits.toString(),withdrawnStroops:withdrawals.toString(),roundingDifferenceStroops:(deposits-withdrawals).toString(),allFeePayersChargedStroops:spent().toString()}
}
const amount=(s:string)=>{const [a,b='']=s.split('.');return BigInt(a!)*10000000n+BigInt(b.padEnd(7,'0'))}
async function funds(){
 const fetchJson=async(url:string)=>{const r=await fetch(url);assert(r.ok,'Horizon read');return r.json()}
 const [a,l]=await Promise.all([fetchJson(HORIZON+'/accounts/'+OWNER),fetchJson(HORIZON+'/ledgers?order=desc&limit=1')])
 const b=a.balances.find((x:any)=>x.asset_type==='native'), reserve=BigInt(l._embedded.records[0].base_reserve_in_stroops)*BigInt(2+a.subentry_count+a.num_sponsoring-a.num_sponsored)
 return {balance:amount(b.balance),reserve,available:amount(b.balance)-reserve-amount(b.selling_liabilities)}
}
async function ownerAccount(){
 try{return await server.getAccount(OWNER)}catch{
  // RPC wraps transient ledger reads as "Account not found"; verify fallback identity.
  const r=await fetch(HORIZON+'/accounts/'+OWNER);assert(r.ok,'Owner sequence unavailable')
  const a=await r.json();assert.equal(a.account_id,OWNER);return new Account(OWNER,a.sequence)
 }
}
async function base(op:any){return new TransactionBuilder(await ownerAccount(),{fee:'1000',networkPassphrase:PASS}).addOperation(op).setTimeout(180).build()}
function assemble(tx:any,sim:any){
 const op=tx.operations[0];assert.equal(op.type,'invokeHostFunction')
 return TransactionBuilder.cloneFrom(tx,{fee:'1000',networkPassphrase:PASS,sorobanData:sim.transactionData.build()}).clearOperations().addOperation(Operation.invokeHostFunction({func:op.func,auth:op.auth?.length?op.auth:(sim.result?.auth??[])})).build()
}
async function prepared(op:any){
 const tx=await base(op), sim=await server.simulateTransaction(tx)
 assert(rpc.Api.isSimulationSuccess(sim),'Simulation: '+('error' in sim?sim.error:'no result'))
 assert(!('restorePreamble' in sim&&sim.restorePreamble),'Restore outside proof')
 const ready=assemble(tx,sim)
 assert.equal(BigInt(ready.fee),BigInt(sim.minResourceFee)+1000n)
 return ready
}
async function submit(tx:any,label:string){
 assert(execute,'Read-only mode');assert(!done(label),'Duplicate completed action')
 const fee=BigInt(tx.fee)
 assert(spent()+fee+CAP+1_000_000n<=TOTAL_CAP,'10 XLM proof cap, preserving 0.1 XLM cleanup')
 assert((await funds()).available>=fee+CAP+1_000_000n,'Deployer reserve protection')
 const cli=spawnSync('stellar',['tx','sign','--sign-with-key','mainnet_deployer','--rpc-url',RPC,'--network-passphrase',PASS],{input:tx.toXDR(),encoding:'utf8',maxBuffer:2*1024*1024})
 assert.equal(cli.status,0,'CLI signing failed')
 const signed:any=TransactionBuilder.fromXDR(cli.stdout.trim(),PASS)
 assert(signed.hash().equals(tx.hash()));assert(signed.signatures.some((s:any)=>Keypair.fromPublicKey(OWNER).verify(signed.hash(),s.signature())))
 const item:any={label,hash:tx.hash().toString('hex'),status:'READY',maxFeeStroops:fee.toString()}
 state.transactions.push(item);save()
 const sent=await server.sendTransaction(signed);item.status=sent.status;save()
 assert(['PENDING','DUPLICATE'].includes(sent.status),'Broadcast '+sent.status)
 for(let i=0;i<80;i++){
  const r=await server.getTransaction(item.hash)
  if(r.status==='SUCCESS'||r.status==='FAILED'){
   item.status=r.status;item.ledger=r.ledger;item.chargedFeeStroops=r.resultXdr.feeCharged().toString()
   item.resultXdr=r.resultXdr.toXDR('base64');item.envelopeXdr=r.envelopeXdr.toXDR('base64')
   item.events=(r.events?.contractEventsXdr??[]).flat().map((e:any)=>({contract:e.contractId()?Address.contract(e.contractId()).toString():null,topics:e.body().v0().topics().map((v:any)=>scValToNative(v)),data:String(scValToNative(e.body().v0().data()))}))
   save();console.log('RECEIPT',JSON.stringify({label,hash:item.hash,status:r.status,fee:item.chargedFeeStroops}))
   assert.equal(r.status,'SUCCESS');return r as any
  }
  await pause(1500)
 }
 throw new Error('Pending receipt '+item.hash+'; do not retry until reconciled')
}
async function view(target:string,fn:string,args:xdr.ScVal[]=[]){
 const sim=await server.simulateTransaction(await base(new Contract(target).call(fn,...args)))
 assert(rpc.Api.isSimulationSuccess(sim)&&sim.result,'View '+fn+' '+('error' in sim?sim.error:'empty'))
 return sim.result.retval
}
const key=(id:string)=>xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({contract:new Address(id).toScAddress(),key:xdr.ScVal.scvLedgerKeyContractInstance(),durability:xdr.ContractDataDurability.persistent()}))
async function instance(id:string){
 const r=await server.getLedgerEntries(key(id));if(!r.entries.length)return null
 const v=r.entries[0]!.val.contractData().val().instance()
 return {hash:v.executable().wasmHash().toString('hex'),storageEntries:v.storage()?.length??0,ledger:r.latestLedger}
}
async function codeLive(digest:string){return (await server.getLedgerEntries(xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({hash:Buffer.from(digest,'hex')})))).entries.length===1}
function agentKey(){
 const line=readFileSync('/home/ubuntu/git/github.com/untangledfinance/octogate/.env','utf8').split('\n').find(l=>/^\s*(?:export\s+)?MAINNET_SA_AGENT_SECRET\s*=/.test(l))
 const secret=line?.slice(line.indexOf('=')+1).match(/\bS[A-Z2-7]{55}\b/)?.[0]
 assert(secret,'Agent key unavailable')
 const k=Keypair.fromSecret(secret);assert.equal(k.publicKey(),AGENT);return k
}
function contexts(inv:xdr.SorobanAuthorizedInvocation):{target:string,method:string}[]{
 const f=inv.function(),row=f.switch().name==='sorobanAuthorizedFunctionTypeContractFn'?{target:Address.fromScAddress(f.contractFn().contractAddress()).toString(),method:f.contractFn().functionName().toString()}:{target:'*',method:f.switch().name}
 return [row,...inv.subInvocations().flatMap(contexts)]
}
const invoke=(target:string,fn:string,args:xdr.ScVal[])=>(auth:xdr.SorobanAuthorizationEntry[])=>Operation.invokeContractFunction({contract:target,function:fn,args,auth})
async function authorize(operator:string,operation:(auth:xdr.SorobanAuthorizationEntry[])=>any,rules:Record<string,number>,adapterSigner=false,deny=false){
 const recording=await server.simulateTransaction(await base(operation([])))
 assert(rpc.Api.isSimulationSuccess(recording),'Recording: '+('error' in recording?recording.error:'empty'))
 const original=recording.result?.auth?.find(a=>a.credentials().switch().name==='sorobanCredentialsAddress'&&Address.fromScAddress(a.credentials().address().address()).toString()===prime)
 assert(original,'Prime authorization missing')
 const seen=contexts(original.rootInvocation()),ids=seen.map(c=>{const n=rules[c.target]??rules['*'];assert(n!==undefined,'Missing rule '+c.target);return n})
 const expiry=(await server.getLatestLedger()).sequence+120
 const digest=authDigest(signaturePayload(PASS,original.credentials().address().nonce(),expiry,original.rootInvocation()),ids)
 let delegated=delegatedSignerEntry(prime,digest)
 if(operator===AGENT){
  const nonce=randomBytes(8).readBigUInt64BE()&((1n<<63n)-1n)
  delegated=await authorizeEntry(new xdr.SorobanAuthorizationEntry({rootInvocation:delegated.rootInvocation(),credentials:xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({address:new Address(AGENT).toScAddress(),nonce:xdr.Int64.fromString(nonce.toString()),signatureExpirationLedger:expiry,signature:xdr.ScVal.scvVoid()}))}),agentKey(),expiry,PASS)
 }else assert.equal(operator,OWNER)
 const auth=[...(recording.result?.auth??[]).filter(a=>a!==original),accountEntry(original,expiry,authPayload([operator,...(adapterSigner?[adapter]:[])],ids)),delegated]
 const tx=await base(operation(auth)), sim=await server.simulateTransaction(tx)
 if(deny){assert(rpc.Api.isSimulationError(sim),'Attack permitted');return {error:sim.error,contexts:seen} as any}
 assert(rpc.Api.isSimulationSuccess(sim),'Enforcing: '+('error' in sim?sim.error:'empty')+' ids='+ids)
 const ready=assemble(tx,sim)
 return {tx:ready,contexts:seen}
}
const call=(target:string,fn:string,args:xdr.ScVal[],auth:xdr.ScVal[]=[])=>map({target:addr(target),function_name:sym(fn),args:vec(args),executor_authorizations:vec(auth)})
const pull=(n:bigint,to=adapter)=>call(TOKEN,'transfer_from',[addr(prime),addr(OWNER),addr(to),int(n)])
function pool(n:bigint,kind=0,recipient=OWNER){
 const auth=vec([sym('Contract'),map({context:map({contract:addr(TOKEN),fn_name:sym('transfer'),args:vec([addr(adapter),addr(POOL),int(n)])}),sub_invocations:vec([])})])
 return call(POOL,'submit',[addr(prime),addr(adapter),addr(recipient),vec([map({address:addr(TOKEN),amount:int(n),request_type:u32(kind)})])],kind===0?[auth]:[])
}
const request=(calls:xdr.ScVal[])=>[addr(prime),addr(INTERPRETER),vec(calls),vec([])]
function root(calls:xdr.ScVal[],variable=true){
 const req=vec(request(calls)),projected=projectExecutionRequest(req)
 const slots=projected.flatMap((v,index)=>v.switch().name==='scvI128'&&big(v)===AMOUNT?[index]:[])
 return buildExecutionBatchPolicy(req,variable&&slots.length?[{slots,min:'1',maxExclusive:CAP.toString()}]:[])
}
const literalA=(value:string)=>({kind:'literal_address',value}),literalS=(value:string)=>({kind:'literal_symbol',value}),literalI=(n:bigint)=>({kind:'literal_i128',value:n.toString()})
const arg=(index:number)=>({kind:'call_arg',index}),eq=(left:any,right:any)=>({op:'eq',left,right}),and=(...children:any[])=>({op:'and',children})
const positive=(a:any)=>[{op:'gt',left:a,right:literalI(0n)},{op:'lt',left:a,right:literalI(CAP)}]
function installOp(name:string,target:string,signer:string,encoded:any){
 const params=map({grammar_version:u32(5),install_nonce:u32(1),predicate:xdr.ScVal.scvBytes(Buffer.from(encoded.encodedPredicate,'base64')),predicate_hash:xdr.ScVal.scvBytes(Buffer.from(encoded.predicateHash,'hex')),policy_admins:vec([delegatedSigner(OWNER)])})
 return invoke(prime,'add_context_rule',[vec([sym('CallContract'),addr(target)]),xdr.ScVal.scvString(name),xdr.ScVal.scvVoid(),vec([delegatedSigner(signer)]),xdr.ScVal.scvMap([new xdr.ScMapEntry({key:addr(INTERPRETER),val:params})])])
}
async function install(name:string,target:string,signer:string,encoded:any){
 if(state.rules[name]!==undefined)return
 const b=await authorize(OWNER,installOp(name,target,signer,encoded),{'*':0}),r=await submit(b.tx,'install '+name)
 state.rules[name]=fields(r.returnValue).get('id')!.u32();save()
}
async function bind(name:string){
 if(state.bound.includes(name))return
 const b=await authorize(OWNER,invoke(INTERPRETER,'bind_executor',[vec([addr(prime),u32(state.rules[name])]),addr(adapter)]),{'*':0})
 await submit(b.tx,'bind '+name);state.bound.push(name);save()
}
const rules=(name:string)=>({[adapter]:state.rules[name],[TOKEN]:state.rules.token,[POOL]:state.rules.pool})
const execution=(calls:xdr.ScVal[],name:string,deny=false)=>authorize(AGENT,invoke(adapter,'execute',request(calls)),rules(name),true,deny)
async function snapshot(){
 const balance=async(a:string)=>big(await view(TOKEN,'balance',[addr(a)])).toString(),p=fields(await view(POOL,'get_positions',[addr(prime)]))
 return {wallet:await balance(OWNER),prime:await balance(prime),adapter:await balance(adapter),primeAllowance:big(await view(TOKEN,'allowance',[addr(OWNER),addr(prime)])).toString(),adapterAllowance:big(await view(TOKEN,'allowance',[addr(OWNER),addr(adapter)])).toString(),supplyShares:(p.get('supply')?.map()??[]).reduce((n,e)=>n+big(e.val()),0n).toString(),collateralEntries:p.get('collateral')?.map()?.length??0,liabilityEntries:p.get('liabilities')?.map()?.length??0}
}
async function check(name:string,fn:()=>Promise<any>){if(state.checks.some((c:any)=>c.name===name))return;const result=await fn();state.checks.push({name,result});save();console.log('PASS',name)}
async function deny(name:string,calls:xdr.ScVal[],rootName='supply'){
 await check(name,async()=>{const before=await snapshot(),result=await execution(calls,rootName,true);assert(/Error\((Auth|Contract),/.test(result.error),'Unexpected '+result.error);assert.deepEqual(await snapshot(),before);return {stage:'enforcing RPC simulation',error:result.error,unchanged:true}})
}
async function approval(n:bigint,label:string){
 if(big(await view(TOKEN,'allowance',[addr(OWNER),addr(prime)]))===n)return
 const count=state.transactions.filter((t:any)=>t.label===label||t.label.startsWith(label+' retry ')).length
 const unique=count?label+' retry '+count:label
 await submit(await prepared(new Contract(TOKEN).call('approve',addr(OWNER),addr(prime),int(n),u32((await server.getLatestLedger()).sequence+1000))),unique)
}
// Verify registry, code identities, and preflight costs before any mutation.
assert.equal((await server.getNetwork()).passphrase,PASS)
const cli=spawnSync('stellar',['keys','address','mainnet_deployer'],{encoding:'utf8'});assert.equal(cli.status,0);assert.equal(cli.stdout.trim(),OWNER)
const registryText=await fetch(REGISTRY).then(async r=>{assert(r.ok);return r.text()}),registry=JSON.parse(registryText)
assert.equal(registry.ids.FixedV2,POOL);assert.equal(registry.ids.poolFactoryV2,FACTORY);assert.equal(registry.ids.XLM,TOKEN)
assert.equal((await instance(FACTORY))?.hash,FACTORY_HASH);assert.equal((await instance(POOL))?.hash,POOL_HASH)
assert.equal(scValToNative(await view(FACTORY,'is_pool',[addr(POOL)])),true)
assert.equal((await instance(INTERPRETER))?.hash,INTERPRETER_HASH);assert.equal((await view(INTERPRETER,'grammar_version')).u32(),5)
for(const h of [OZ_HASH,INTERPRETER_HASH,ADAPTER_HASH])assert(await codeLive(h),'Missing code '+h)
const createPrime=Operation.createCustomContract({address:new Address(OWNER),salt:primeSalt,wasmHash:Buffer.from(OZ_HASH,'hex'),constructorArgs:[vec([delegatedSigner(OWNER)]),map({})]})
const freshPrimeFee=(await instance(prime))?null:(await prepared(createPrime)).fee
const tinySupplyFee=(await prepared(new Contract(POOL).call('submit',addr(OWNER),addr(OWNER),addr(OWNER),vec([map({address:addr(TOKEN),amount:int(AMOUNT),request_type:u32(0)})])))).fee
state.preflight={at:new Date().toISOString(),registry:REGISTRY,registrySha256:hash(Buffer.from(registryText)).toString('hex'),factory:FACTORY,poolCode:POOL_HASH,factoryCode:FACTORY_HASH,ownerFunds:await funds(),freshPrimeMaxFeeStroops:freshPrimeFee,tinySupplyMaxFeeStroops:tinySupplyFee};save()
console.log('PREFLIGHT',JSON.stringify({prime,adapter,...state.preflight},(_k,v)=>typeof v==='bigint'?v.toString():v))
if(args.includes('--agent-source-prepare')){
 assert(execute&&state.complete,'Complete bounded proof before preparing standalone demo')
 assert.equal((await snapshot()).supplyShares,'0')
 await approval(AMOUNT,'approve standalone agent-source supply')
 state.agentSourcePreparation={at:new Date().toISOString(),amount:AMOUNT.toString(),snapshot:await snapshot()}
 save();console.log('AGENT SOURCE READY',JSON.stringify(state.agentSourcePreparation));process.exit(0)
}
if(args.includes('--agent-source-cleanup')){
 assert(execute&&state.complete&&state.agentSourcePreparation,'Standalone demo not prepared')
 const txHash=process.env.PRIME_AGENT_SOURCE_TX;assert(txHash&&/^[a-f0-9]{64}$/.test(txHash),'PRIME_AGENT_SOURCE_TX required')
 const r=await server.getTransaction(txHash);assert.equal(r.status,'SUCCESS')
 if(r.status!=='SUCCESS')throw new Error('Agent transaction not confirmed')
 const tx:any=TransactionBuilder.fromXDR(r.envelopeXdr.toXDR('base64'),PASS)
 assert.equal(tx.source,AGENT);assert.equal(tx.signatures.length,1)
 assert(Keypair.fromPublicKey(AGENT).verify(tx.hash(),tx.signatures[0].signature()))
 const op=tx.operations[0];assert.equal(tx.operations.length,1);assert.equal(op.type,'invokeHostFunction')
 assert.equal(Address.fromScAddress(op.func.invokeContract().contractAddress()).toString(),adapter)
 assert.equal(op.func.invokeContract().functionName().toString(),'execute')
 for(const entry of op.auth??[])if(entry.credentials().switch().name==='sorobanCredentialsAddress')assert.notEqual(Address.fromScAddress(entry.credentials().address().address()).toString(),OWNER,'Owner authorization entry present')
 const primeAuth=(op.auth??[]).find((entry:any)=>entry.credentials().switch().name==='sorobanCredentialsAddress'&&Address.fromScAddress(entry.credentials().address().address()).toString()===prime)
 assert(primeAuth,'Prime authorization missing');const payload=fields(primeAuth.credentials().address().signature())
 assert.deepEqual(payload.get('context_rule_ids')!.vec()!.map(x=>x.u32()),[state.rules.supply,state.rules.token,state.rules.pool])
 assert.deepEqual(payload.get('signers')!.map()!.map(x=>Address.fromScVal(x.key().vec()![1]!).toString()).sort(),[AGENT,adapter].sort())
 assert.deepEqual(op.func.invokeContract().args().map((x:xdr.ScVal)=>x.toXDR('base64')),request([pull(AMOUNT),pool(AMOUNT)]).map(x=>x.toXDR('base64')))
 const eventList=(r.events?.contractEventsXdr??[]).flat().map((e:any)=>({contract:e.contractId()?Address.contract(e.contractId()).toString():null,topics:e.body().v0().topics().map((v:any)=>scValToNative(v)),data:String(scValToNative(e.body().v0().data()))}))
 const transfers=eventList.filter((e:any)=>e.contract===TOKEN&&e.topics[0]==='transfer').map((e:any)=>[e.topics[1],e.topics[2],e.data])
 assert.deepEqual(transfers,[[OWNER,adapter,AMOUNT.toString()],[adapter,POOL,AMOUNT.toString()]])
 if(!done('standalone agent-source supply'))state.transactions.push({label:'standalone agent-source supply',hash:txHash,status:'SUCCESS',ledger:r.ledger,source:AGENT,ownerTransactionSignature:false,chargedFeeStroops:r.resultXdr.feeCharged().toString(),maxFeeStroops:tx.fee,envelopeXdr:r.envelopeXdr.toXDR('base64'),events:eventList,verifiedTokenTransfers:transfers})
 state.agentSourceExecution={hash:txHash,source:AGENT,onlyEnvelopeSignature:AGENT,ownerSignature:false,afterSupply:await snapshot()};save()
 try{
  if(BigInt((await snapshot()).supplyShares)>0n)await submit((await execution([pool(ALL,1)],'withdraw')).tx,'standalone agent-source withdraw all')
 }finally{await approval(0n,'revoke standalone demo allowance')}
 state.final=await snapshot()
 for(const k of ['prime','adapter','primeAllowance','adapterAllowance','supplyShares'])assert.equal(state.final[k],'0')
 state.totalChargedFeesStroops=spent().toString();state.agentSourceExecution.final=state.final;state.agentSourceExecution.cleanupAt=new Date().toISOString();save()
 console.log('AGENT SOURCE PROOF CLEAN',JSON.stringify(state.agentSourceExecution));process.exit(0)
}
if(state.complete){
 const lateFailure=state.checks.find((c:any)=>c.name==='late failure simulation leaves balances unchanged')
 assert(lateFailure?.result.error.includes('negative amount is not allowed'))
 assert(lateFailure.result.error.includes('topics:[fn_return, transfer_from]'))
 const final=await snapshot()
 for(const k of ['prime','adapter','primeAllowance','adapterAllowance','supplyShares'])assert.equal((final as any)[k],'0')
 assert.equal(final.collateralEntries,0);assert.equal(final.liabilityEntries,0)
 assert.equal((await instance(adapter))?.hash,ADAPTER_HASH);assert.equal((await instance(adapter))?.storageEntries,0)
 const observed=[]
 for(const [name,id] of Object.entries(state.rules)){
  const k=xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({contract:new Address(INTERPRETER).toScAddress(),key:vec([addr(prime),u32(id as number),u32(1)]),durability:xdr.ContractDataDurability.persistent()}))
  const entry=(await server.getLedgerEntries(k)).entries[0];assert(entry,'Missing '+name+' policy')
  const doc=fields(entry.val.contractData().val()),executor=doc.get('executor');assert(executor,'Missing executor')
  assert.equal(Address.fromScVal(executor).toString(),adapter)
  observed.push({name,id,executor:adapter})
 }
 state.financialSummary=financialSummary()
 state.independentVerification={at:new Date().toISOString(),ledger:(await server.getLatestLedger()).sequence,final,bindings:observed}
 save();console.log('READ-ONLY VERIFICATION PASSED',JSON.stringify(state.independentVerification))
 process.exit(0)
}
if(!execute)process.exit(0)
for(const t of state.transactions)assert(['SUCCESS','FAILED','ERROR'].includes(t.status),'Unresolved transaction '+t.hash)
if(state.complete){console.log('Already complete');process.exit(0)}
if(!(await instance(prime)))await submit(await prepared(createPrime),'deploy dedicated Prime')
assert.equal((await instance(prime))?.hash,OZ_HASH)
if(!(await instance(adapter))){
 const op=(auth:xdr.SorobanAuthorizationEntry[])=>Operation.createCustomContract({address:new Address(prime),salt,wasmHash:Buffer.from(ADAPTER_HASH,'hex'),constructorArgs:[],auth})
 await submit((await authorize(OWNER,op,{'*':0})).tx,'activate stateless adapter')
}
assert.equal((await instance(adapter))?.hash,ADAPTER_HASH);assert.equal((await instance(adapter))?.storageEntries,0)
const tokenPolicy=encodePredicate(and(eq({kind:'call_fn'},literalS('transfer_from')),eq(arg(0),literalA(prime)),eq(arg(1),literalA(OWNER)),eq(arg(2),literalA(adapter)),...positive(arg(3))) as any)
const field=(name:string)=>({kind:'call_arg_field',index:3,element:0,field:name})
const poolPolicy=encodePredicate(and(eq({kind:'call_fn'},literalS('submit')),eq(arg(0),literalA(prime)),eq(arg(1),literalA(adapter)),eq(arg(2),literalA(OWNER)),eq({kind:'call_arg_len',index:3},{kind:'literal_u32',value:1}),eq(field('address'),literalA(TOKEN)),{op:'or',children:[and(eq(field('request_type'),{kind:'literal_u32',value:0}),...positive(field('amount'))),and(eq(field('request_type'),{kind:'literal_u32',value:1}),eq(field('amount'),literalI(ALL)))]}) as any)
const plans:[string,string,string,any][]=[['token',TOKEN,adapter,tokenPolicy],['pool',POOL,adapter,poolPolicy],['supply',adapter,AGENT,root([pull(AMOUNT),pool(AMOUNT)])],['withdraw',adapter,AGENT,root([pool(ALL,1)])]]
const forecasts=[]
for(const [name,target,signer,policy] of plans)if(state.rules[name]===undefined)forecasts.push({name,fee:(await authorize(OWNER,installOp(name,target,signer,policy),{'*':0})).tx.fee})
state.installForecast={plans:forecasts,totalWithPriorAndCompletionReserve:(spent()+forecasts.reduce((n,x)=>n+BigInt(x.fee),0n)+15_000_000n).toString()};save()
console.log('INSTALL FORECAST',JSON.stringify(state.installForecast))
assert(BigInt(state.installForecast.totalWithPriorAndCompletionReserve)<=TOTAL_CAP,'Install costs exceed proof budget')
// Every child is bound before an agent root becomes usable.
for(const [name,target,signer,policy] of plans){await install(name,target,signer,policy);await bind(name)}
try {
await approval((done('agent supply')?0n:AMOUNT)+(done('owner approved over-cap supply')?0n:CAP),'approve Prime only')
await deny('incomplete pull-only batch rejected',[pull(AMOUNT)])
await deny('unequal funding and supply rejected',[pull(AMOUNT),pool(AMOUNT-1n)])
await deny('over-cap rejected',[pull(CAP),pool(CAP)])
await check('direct pull cannot impersonate adapter',async()=>{
 const b=await authorize(AGENT,invoke(TOKEN,'transfer_from',[addr(prime),addr(OWNER),addr(adapter),int(AMOUNT)]),{[TOKEN]:state.rules.token},true,true)
 assert(/Error\((Auth|Contract),/.test(b.error));return {stage:'enforcing RPC simulation',error:b.error}
})
await check('real Blend agent supply',async()=>{
 const before=await snapshot();if(!done('agent supply'))await submit((await execution([pull(AMOUNT),pool(AMOUNT)],'supply')).tx,'agent supply')
 const after=await snapshot();assert(BigInt(after.supplyShares)>0n);assert.equal(after.prime,'0');assert.equal(after.adapter,'0');assert.equal(after.adapterAllowance,'0')
 return {before,after}
})
await deny('wrong withdraw recipient rejected',[pool(ALL,1,AGENT)],'withdraw')
await check('agent withdraw all directly to wallet',async()=>{
 if(!done('agent withdraw all'))await submit((await execution([pool(ALL,1)],'withdraw')).tx,'agent withdraw all')
 const after=await snapshot();assert.equal(after.supplyShares,'0');return after
})
// A known token call fails AFTER the first pull in the invocation tree. Simulation only.
await check('late failure simulation leaves balances unchanged',async()=>{
 const before=await snapshot()
 const fail=call(TOKEN,'transfer',[addr(adapter),addr(POOL),int(-1n)])
 const sim=await server.simulateTransaction(await base(new Contract(adapter).call('execute',...request([pull(1n),fail]))))
 assert(rpc.Api.isSimulationError(sim));assert(/negative amount is not allowed/.test(sim.error),sim.error)
 assert(sim.error.includes('topics:[fn_return, transfer_from]'),'First wallet pull did not complete before failure')
 assert.deepEqual(await snapshot(),before);return {stage:'RPC simulation only',error:sim.error,unchanged:true,includedOnLedger:false}
})
await check('owner approves exact over-cap batch',async()=>{
 const before=await snapshot()
 // Rule 0 explicitly authorizes the entire exact invocation tree. Agent policies are unchanged.
 if(!done('owner approved over-cap supply'))await submit((await authorize(OWNER,invoke(adapter,'execute',request([pull(CAP),pool(CAP)])),{'*':0})).tx,'owner approved over-cap supply')
 const after=await snapshot();assert(BigInt(after.supplyShares)>0n);assert.equal(after.prime,'0');assert.equal(after.adapter,'0')
 return {before,after,authority:'owner rule 0 with exact Soroban invocation signature',browserWalletVerified:false}
})
await check('withdraw owner-approved deposit',async()=>{
 if(!done('withdraw approved deposit'))await submit((await execution([pool(ALL,1)],'withdraw')).tx,'withdraw approved deposit')
 const after=await snapshot();assert.equal(after.supplyShares,'0');return after
})

} finally {
 try {
  if(BigInt((await snapshot()).supplyShares)>0n)await submit((await authorize(OWNER,invoke(adapter,'execute',request([pool(ALL,1)])),{'*':0})).tx,'emergency owner withdraw all')
 } finally { await approval(0n,'revoke remaining allowance') }
}
const final=await snapshot()
assert.equal(final.prime,'0');assert.equal(final.adapter,'0');assert.equal(final.primeAllowance,'0');assert.equal(final.adapterAllowance,'0');assert.equal(final.supplyShares,'0');assert.equal(final.collateralEntries,0);assert.equal(final.liabilityEntries,0)
for(const [label,n] of [['agent supply',AMOUNT],['owner approved over-cap supply',CAP]] as const){
 const tx=done(label),transfers=tx.events.filter((e:any)=>e.contract===TOKEN&&e.topics[0]==='transfer').map((e:any)=>[e.topics[1],e.topics[2],e.data])
 assert.deepEqual(transfers,[[OWNER,adapter,n.toString()],[adapter,POOL,n.toString()]])
 tx.verifiedTokenTransfers=transfers
}
state.final=final;state.totalChargedFeesStroops=spent().toString();state.complete=true;state.completedAt=new Date().toISOString();save()
console.log('MAINNET VERIFIED',JSON.stringify({prime,adapter,checks:state.checks.length,fees:state.totalChargedFeesStroops,final}))
