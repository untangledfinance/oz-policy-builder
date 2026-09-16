/**
 * Bounded mainnet proof on a NEW, dedicated OZ Prime. Default is read-only.
 * --execute needs verified pinned deployments and an explicit 10.5 XLM cap.
 * Owner envelopes use CLI mainnet_deployer; the distinct agent signs Soroban
 * authorization only, in memory. No customer position or non-native asset.
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  Address, Asset, Contract, Keypair, Networks, Operation, TransactionBuilder,
  authorizeEntry, hash, nativeToScVal, rpc, scValToNative, xdr, type Transaction,
} from '@stellar/stellar-sdk'
import { counterfactualStellarContractId } from './execution-counterfactual.ts'
import { accountEntry, authDigest, authPayload, delegatedSigner, delegatedSignerEntry, signaturePayload } from './execution-oz-auth.ts'
import { encodeExecutionDocument, scopedBlendExecutionPlans } from '../packages/policy-synth/src/install/scoped-execution.ts'
import { docLedgerKey, decodeStoredPredicateBytes } from '../packages/policy-synth/src/install/read-account-rules.ts'

const PASS = Networks.PUBLIC
const RPC = 'https://mainnet.sorobanrpc.com'
const HORIZON = 'https://horizon.stellar.org'
const OWNER = 'GCIVG2AIEWMDA43HX2HRCYVNY7PH7HMPYVN42LQ5XBSHBLHFUWG47NFN'
const AGENT = 'GCTI2WE25C3Z4CUQXKT6RSAC4NS7M7BBVLR5PM7VS6OKYQPOABLJSMXE'
const IDENTITY = 'mainnet_deployer'
const INTERPRETER = 'CCZDVEJOVQ2H5NDLDYLF6N47WDC2ZW7UTLY4Z5LCIL3ZMEHUMKNGW747'
const INTERPRETER_HASH = '67bbee0914172e0c6d2cdb4038b986660265f53d7e6443f3da0453656337a15a'
const ADAPTER_HASH = '719240da0e3cf8a7fa32dad3a1af65c01276e4194a8ba68eef7b8a9d27126f7c'
const OZ_HASH = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9'
const POOL = 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD'
const FACTORY = 'CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU'
const FACTORY_HASH = '31328050548831f63d2b72e37bcfd0bb7371b7907135755dbe09ed434d755ca9'
const POOL_HASH = 'a41fc53d6753b6c04eb15b021c55052366a4c8e0e21bc72700f461264ec1350e'
const REGISTRY = 'https://raw.githubusercontent.com/blend-capital/blend-utils/main/mainnet.contracts.json'
const TOKEN = Asset.native().contractId(PASS)
const PRINCIPAL = 100_000n // 0.01 XLM; no other asset can be selected.
const AMOUNT_CAP = 200_000n // strict per-call cap; oversized withdrawal closes tiny position.
const TOTAL_CAP = 105_000_000n // 10.5 XLM, authorized within the total 120 XLM task budget.
const CLEANUP_RESERVE = 4_000_000n // retain 0.4 XLM budget before depositing.
const args = process.argv.slice(2)
assert(args.every(x => ['--execute', '--fee-cap-xlm', '10.5'].includes(x)), 'Unsupported argument')
const execute = args.includes('--execute')
if (execute) assert(args[args.indexOf('--fee-cap-xlm') + 1] === '10.5', '--execute requires --fee-cap-xlm 10.5')
const server = new rpc.Server(RPC)
const path = 'docs/audit/evidence/scoped-mainnet-verification.json'
const primeSalt = hash(Buffer.from('prime-scoped-mainnet-verification:2026-09-16:v1'))
const prime = await counterfactualStellarContractId({ deployer: OWNER, salt: primeSalt, networkPassphrase: PASS })
const adapterSalt = hash(Buffer.from('prime-execution:v2'))
const executor = await counterfactualStellarContractId({ deployer: prime, salt: adapterSalt, networkPassphrase: PASS })
const addr = (s: string) => new Address(s).toScVal()
const sym = (s: string) => xdr.ScVal.scvSymbol(s)
const u32 = (n: number) => xdr.ScVal.scvU32(n)
const int = (n: bigint) => nativeToScVal(n, { type: 'i128' })
const vec = (xs: xdr.ScVal[]) => xdr.ScVal.scvVec(xs)
const map = (m: Record<string,xdr.ScVal>) => xdr.ScVal.scvMap(Object.keys(m).sort().map(k => new xdr.ScMapEntry({key:sym(k),val:m[k]!})))
const document = encodeExecutionDocument({executor,plans:scopedBlendExecutionPlans({prime,executor,custody:OWNER,token:TOKEN,pool:POOL,maxAmountBaseUnits:AMOUNT_CAP.toString()})})
const receipt: any = existsSync(path) ? JSON.parse(readFileSync(path,'utf8')) : {
  network:PASS,owner:OWNER,agent:AGENT,prime,executor,interpreter:INTERPRETER,pool:POOL,token:TOKEN,
  hashes:{oz:OZ_HASH,adapter:ADAPTER_HASH,interpreter:INTERPRETER_HASH,pool:POOL_HASH},
  feeAndPrincipalCapStroops:TOTAL_CAP.toString(),principalStroops:PRINCIPAL.toString(),
  productionDocument:document,transactions:[],rules:{},checks:{},
}
assert.equal(receipt.network,PASS);assert.equal(receipt.prime,prime)
assert.equal(receipt.productionDocument.predicateHash,document.predicateHash)
receipt.feeAndPrincipalCapStroops=TOTAL_CAP.toString()
receipt.capAdjustment??={initialCapStroops:'15000000',adjustedCapStroops:TOTAL_CAP.toString(),overallAuthorizedTaskCapXlm:'120',reason:'First scoped rule simulation exceeded initial cap; adjusted explicitly before any rule install'}
const save = () => { mkdirSync('docs/audit/evidence',{recursive:true});writeFileSync(path,JSON.stringify(receipt,(_key,value)=>typeof value==='bigint'?value.toString():value,2)+'\n') }
const sleep = (ms:number) => new Promise(r=>setTimeout(r,ms))
const amount = (s:string) => { const [a,b='']=s.split('.');return BigInt(a!)*10_000_000n+BigInt(b.padEnd(7,'0')) }
async function json(url:string) { const r=await fetch(url);if(!r.ok)throw new Error('Read failed HTTP '+r.status);return r.json() }
async function funds(address:string) {
  const [a,l]=await Promise.all([json(HORIZON+'/accounts/'+address),json(HORIZON+'/ledgers?order=desc&limit=1')])
  const b=a.balances.find((x:any)=>x.asset_type==='native')
  const reserve=BigInt(l._embedded.records[0].base_reserve_in_stroops)*BigInt(2+a.subentry_count+a.num_sponsoring-a.num_sponsored)
  return {balance:amount(b.balance),reserve,available:amount(b.balance)-reserve-amount(b.selling_liabilities)}
}
const instanceKey = (id:string) => xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({contract:new Address(id).toScAddress(),key:xdr.ScVal.scvLedgerKeyContractInstance(),durability:xdr.ContractDataDurability.persistent()}))
async function instance(id:string) {
  const r=await server.getLedgerEntries(instanceKey(id)),entry=r.entries[0]
  if(!entry)return null
  assert(entry.liveUntilLedgerSeq===undefined||entry.liveUntilLedgerSeq>=r.latestLedger,'Archived instance')
  const v=entry.val.contractData().val().instance()
  const values=new Map((v.storage()??[]).map(x=>{const k=scValToNative(x.key());return [Array.isArray(k)?k[0]:k,scValToNative(x.val())]}))
  return {hash:v.executable().wasmHash().toString('hex'),values,ledger:r.latestLedger}
}
async function codeLive(wasmHash:string) {
  const r=await server.getLedgerEntries(xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({hash:Buffer.from(wasmHash,'hex')})))
  return r.entries.length===1&&(r.entries[0]!.liveUntilLedgerSeq===undefined||r.entries[0]!.liveUntilLedgerSeq!>=r.latestLedger)
}
async function base(op:xdr.Operation) {
  return new TransactionBuilder(await server.getAccount(OWNER),{fee:'1000',networkPassphrase:PASS}).addOperation(op).setTimeout(180).build()
}
async function simulate(op:xdr.Operation) {
  const raw=await base(op),sim=await server.simulateTransaction(raw)
  if(!rpc.Api.isSimulationSuccess(sim))throw new Error('Simulation failed: '+('error' in sim?sim.error:'no result'))
  if('restorePreamble' in sim&&sim.restorePreamble)throw new Error('Restoration is outside this proof budget')
  const invoke=raw.operations[0]!
  assert.equal(invoke.type,'invokeHostFunction')
  if(invoke.type!=='invokeHostFunction')throw new Error('Unexpected operation')
  const builder=TransactionBuilder.cloneFrom(raw,{fee:'1000',sorobanData:sim.transactionData.build(),networkPassphrase:PASS})
  const tx=builder.clearOperations().addOperation(Operation.invokeHostFunction({func:invoke.func,auth:invoke.auth?.length?invoke.auth:(sim.result?.auth??[])})).build()
  assert.equal(BigInt(tx.fee),BigInt(sim.minResourceFee)+1000n,'Unexpected fee construction')
  return {tx,fee:BigInt(tx.fee),ledger:sim.latestLedger}
}
async function view(target:string,fn:string,callArgs:xdr.ScVal[]=[]) {
  const s=await server.simulateTransaction(await base(new Contract(target).call(fn,...callArgs)))
  if(!rpc.Api.isSimulationSuccess(s)||!s.result)throw new Error('Read '+fn+' failed: '+('error' in s?s.error:'empty'))
  return s.result.retval
}
const committedFees = () => receipt.transactions.reduce((sum:bigint,t:any)=>sum+(t.status==='SUCCESS'||t.status==='FAILED'?BigInt(t.chargedFeeStroops??t.declaredFeeStroops):0n),0n)
const done = (label:string) => receipt.transactions.find((t:any)=>t.label===label&&t.status==='SUCCESS')
async function submit(label:string,p:Awaited<ReturnType<typeof simulate>>,reserve=0n) {
  assert(execute,'Read-only mode')
  if(committedFees()+p.fee+PRINCIPAL+reserve>TOTAL_CAP)throw new Error('Total 10.5 XLM fee/principal cap would be exceeded before '+label+'; proposedFee='+p.fee)
  if((await funds(OWNER)).available < p.fee+PRINCIPAL+1_000_000n)throw new Error('Deployer reserve/buffer protection')
  const signedCli=spawnSync('stellar',['tx','sign','--sign-with-key',IDENTITY,'--rpc-url',RPC,'--network-passphrase',PASS],{input:p.tx.toXDR(),encoding:'utf8',maxBuffer:2*1024*1024})
  if(signedCli.status!==0)throw new Error('CLI owner signing failed; not submitted')
  const signed=TransactionBuilder.fromXDR(signedCli.stdout.trim(),PASS) as Transaction
  assert(signed.hash().equals(p.tx.hash()))
  assert(signed.signatures.some(s=>Keypair.fromPublicKey(OWNER).verify(signed.hash(),s.signature())))
  const item:any={label,hash:signed.hash().toString('hex'),declaredFeeStroops:p.fee.toString(),simulationLedger:p.ledger,status:'READY'}
  receipt.transactions.push(item);save()
  console.log('SUBMIT',label,item.hash,'maxFeeStroops='+p.fee)
  const sent=await server.sendTransaction(signed);item.status=sent.status;save()
  if(sent.status!=='PENDING'&&sent.status!=='DUPLICATE')throw new Error('Broadcast rejected '+sent.status)
  for(let i=0;i<60;i++){
    const r=await server.getTransaction(item.hash)
    if(r.status==='SUCCESS'||r.status==='FAILED'){
      item.status=r.status;item.ledger=r.ledger;item.chargedFeeStroops=r.resultXdr.feeCharged().toString()
      item.envelopeXdr=r.envelopeXdr.toXDR('base64');item.resultXdr=r.resultXdr.toXDR('base64');item.resultMetaXdr=r.resultMetaXdr.toXDR('base64')
      item.events=(r.events?.contractEventsXdr??[]).flat().map((e:any)=>({contract:e.contractId()?Address.contract(e.contractId()).toString():null,topics:e.body().v0().topics().map((v:any)=>scValToNative(v)),data:String(scValToNative(e.body().v0().data()))}))
      save();assert.equal(r.status,'SUCCESS','Failed on chain '+item.hash);return r
    }
    await sleep(1500)
  }
  throw new Error('Unconfirmed '+item.hash+'; inspect before retry')
}
function agentKey() {
  const line=readFileSync('/home/ubuntu/git/github.com/untangledfinance/octogate/.env','utf8').split('\n').find(l=>/^\s*(?:export\s+)?MAINNET_SA_AGENT_SECRET\s*=/.test(l))
  const secret=line?.slice(line.indexOf('=')+1).match(/\bS[A-Z2-7]{55}\b/)?.[0]
  assert(secret,'Configured agent signer unavailable')
  const key=Keypair.fromSecret(secret);assert.equal(key.publicKey(),AGENT);return key
}
async function preparePrime(op:xdr.Operation,operator:string,ruleFor:(inv:xdr.SorobanAuthorizedInvocation)=>number[]) {
  const first=await server.simulateTransaction(await base(op))
  if(!rpc.Api.isSimulationSuccess(first))throw new Error('Recording failed: '+('error' in first?first.error:'empty'))
  const own=first.result?.auth?.find(e=>e.credentials().switch().name==='sorobanCredentialsAddress'&&Address.fromScAddress(e.credentials().address().address()).toString()===prime)
  assert(own,'Prime authorization was not recorded')
  const ids=ruleFor(own.rootInvocation()),expiration=(await server.getLatestLedger()).sequence+120
  const digest=authDigest(signaturePayload(PASS,own.credentials().address().nonce(),expiration,own.rootInvocation()),ids)
  const delegates:xdr.SorobanAuthorizationEntry[]=[]
  for(const _id of ids){
    const raw=delegatedSignerEntry(prime,digest)
    if(operator===OWNER)delegates.push(raw)
    else{
      assert.equal(operator,AGENT)
      const nonce=randomBytes(8).readBigUInt64BE()&((1n<<63n)-1n)
      const entry=new xdr.SorobanAuthorizationEntry({rootInvocation:raw.rootInvocation(),credentials:xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({address:new Address(AGENT).toScAddress(),nonce:xdr.Int64.fromString(nonce.toString()),signatureExpirationLedger:expiration,signature:xdr.ScVal.scvVoid()}))})
      delegates.push(await authorizeEntry(entry,agentKey(),expiration,PASS))
    }
  }
  const passthrough=(first.result?.auth??[]).filter(e=>e!==own)
  return simulate(Operation.invokeHostFunction({func:op.body().invokeHostFunctionOp().hostFunction(),auth:[accountEntry(own,expiration,authPayload([operator],ids)),...delegates,...passthrough]}))
}
const allOwner = (i:xdr.SorobanAuthorizedInvocation):number[] => [0,...i.subInvocations().flatMap(allOwner)]
function agentRules(i:xdr.SorobanAuthorizedInvocation):number[] {
  assert.equal(i.function().switch().name,'sorobanAuthorizedFunctionTypeContractFn')
  const target=Address.fromScAddress(i.function().contractFn().contractAddress()).toString()
  const id=receipt.rules[target];assert(Number.isInteger(id),'Unexpected agent authority context '+target)
  return [id,...i.subInvocations().flatMap(agentRules)]
}
function batchCall(target:string,fn:string,callArgs:xdr.ScVal[],auth:xdr.ScVal[]=[]){return map({target:addr(target),function_name:sym(fn),args:vec(callArgs),executor_authorizations:vec(auth)})}
function batch(supply:boolean,poolAmount=PRINCIPAL) {
  const n=supply?poolAmount:AMOUNT_CAP-1n
  const transfer=vec([sym('Contract'),map({context:map({contract:addr(TOKEN),fn_name:sym('transfer'),args:vec([addr(executor),addr(POOL),int(n)])}),sub_invocations:vec([])})])
  const pool=batchCall(POOL,'submit',[addr(prime),addr(executor),addr(OWNER),vec([map({address:addr(TOKEN),amount:int(n),request_type:u32(supply?0:1)})])],supply?[transfer]:[])
  const calls=supply?[batchCall(TOKEN,'transfer_from',[addr(prime),addr(OWNER),addr(executor),int(PRINCIPAL)]),pool]:[pool]
  return new Contract(executor).call('execute',addr(prime),vec(calls))
}
async function allowance(){return BigInt(scValToNative(await view(TOKEN,'allowance',[addr(OWNER),addr(prime)])))}
async function positions(){return scValToNative(await view(POOL,'get_positions',[addr(prime)]))}
async function snapshot(){
 const balance=async(a:string)=>String(scValToNative(await view(TOKEN,'balance',[addr(a)])))
 const p=await positions()
 const encode=(m:Map<any,any>|Record<string,unknown>)=>(m instanceof Map?Array.from(m):Object.entries(m??{})).map(([k,v])=>[k,String(v)])
 return {custody:await balance(OWNER),prime:await balance(prime),executor:await balance(executor),allowance:String(await allowance()),positions:{supply:encode(p.supply),collateral:encode(p.collateral),liabilities:encode(p.liabilities)}}
}
async function approval(n:bigint,label:string) {
 const ledger=(await server.getLatestLedger()).sequence
 return submit(label,await simulate(new Contract(TOKEN).call('approve',addr(OWNER),addr(prime),int(n),u32(ledger+180))))
}

// Read-only prerequisites, including official registry provenance and factory code.
assert.equal((await server.getNetwork()).passphrase,PASS)
const cli=spawnSync('stellar',['keys','address',IDENTITY],{encoding:'utf8'})
assert.equal(cli.status,0);assert.equal(cli.stdout.trim(),OWNER)
const registryText=await fetch(REGISTRY).then(async r=>{assert(r.ok);return r.text()})
const registry=JSON.parse(registryText)
assert.equal(registry.ids.FixedV2,POOL);assert.equal(registry.ids.poolFactoryV2,FACTORY);assert.equal(registry.ids.XLM,TOKEN)
const [factory,pool,interpreter,ownerFunds,agentFunds]=await Promise.all([instance(FACTORY),instance(POOL),instance(INTERPRETER),funds(OWNER),funds(AGENT)])
assert(factory&&pool);assert.equal(factory.hash,FACTORY_HASH);assert.equal(pool.hash,POOL_HASH)
assert.equal(Buffer.from(factory.values.get('PoolMeta').pool_hash).toString('hex'),POOL_HASH)
assert.equal(scValToNative(await view(FACTORY,'is_pool',[addr(POOL)])),true)
const reserves=scValToNative(await view(POOL,'get_reserve_list')) as string[];assert(reserves.includes(TOKEN))
const liquidity=BigInt(scValToNative(await view(TOKEN,'balance',[addr(POOL)])));assert(liquidity>PRINCIPAL*100n)
assert(await codeLive(OZ_HASH),'Existing pinned OZ code is missing/archived; no upload authorized here')
const coreReady=interpreter?.hash===INTERPRETER_HASH&&await codeLive(INTERPRETER_HASH)&&await codeLive(ADAPTER_HASH)
const createPrime=Operation.createCustomContract({address:new Address(OWNER),salt:primeSalt,wasmHash:Buffer.from(OZ_HASH,'hex'),constructorArgs:[vec([delegatedSigner(OWNER)]),map({})]})
const existingPrime=await instance(prime)
const initialPrimeCost=existingPrime?null:(await simulate(createPrime)).fee.toString()
const tinySupply=await simulate(new Contract(POOL).call('submit',addr(OWNER),addr(OWNER),addr(OWNER),vec([map({address:addr(TOKEN),amount:int(PRINCIPAL),request_type:u32(0)})])))
receipt.preflight={observedAt:new Date().toISOString(),registry:REGISTRY,registrySha256:hash(Buffer.from(registryText)).toString('hex'),factory:FACTORY,factoryCode:factory.hash,poolCode:pool.hash,reserves,nativeLiquidityStroops:liquidity.toString(),poolConfig:scValToNative(await view(POOL,'get_config')),coreReady,ozCodeLive:true,freshPrimeMaxFeeStroops:initialPrimeCost,tinyDirectSupplyMaxFeeStroops:tinySupply.fee.toString(),ownerAvailableStroops:ownerFunds.available.toString(),agentAvailableStroops:agentFunds.available.toString()}
receipt.preflight.poolConfig.min_collateral=String(receipt.preflight.poolConfig.min_collateral)
save();console.log(JSON.stringify({prime,executor,coreReady,preflight:receipt.preflight}))
if(!execute)process.exit(0)
assert(coreReady,'Pinned core deployment not verified; prepare only')
assert(agentFunds.available>=1_000_000n,'Agent reserve/buffer protection')
for(const t of receipt.transactions)assert(['SUCCESS','FAILED','ERROR'].includes(t.status),'Unresolved transaction '+t.hash+'; inspect before new mutation')
if(receipt.complete){console.log('Already complete; no further mutations');process.exit(0)}
if(!existingPrime)await submit('deploy dedicated OZ Prime',await simulate(createPrime))
const primeInstance=await instance(prime);assert.equal(primeInstance?.hash,OZ_HASH)
const ownerRule=await view(prime,'get_context_rule',[u32(0)]),ownerNative=scValToNative(ownerRule)
assert.deepEqual(ownerNative.signers,[['Delegated',OWNER]]);assert.equal(ownerNative.policies.length,0)
receipt.ownerRuleXdr??=ownerRule.toXDR('base64');assert.equal(receipt.ownerRuleXdr,ownerRule.toXDR('base64'));save()
const existingAdapter=await instance(executor)
if(!existingAdapter){
 const op=Operation.createCustomContract({address:new Address(prime),salt:adapterSalt,wasmHash:Buffer.from(ADAPTER_HASH,'hex'),constructorArgs:[addr(prime),addr(INTERPRETER)]})
 await submit('activate deterministic adapter',await preparePrime(op,OWNER,allOwner))
}
const adapter=await instance(executor);assert.equal(adapter?.hash,ADAPTER_HASH);assert.equal(adapter?.values.get('prime'),prime);assert.equal(adapter?.values.get('interpreter'),INTERPRETER)
function ruleOperation(scope:string,name:string) {
 const params=map({grammar_version:u32(6),install_nonce:u32(1),policy_admins:vec([delegatedSigner(OWNER)]),predicate:xdr.ScVal.scvBytes(Buffer.from(document.encodedPredicate,'base64')),predicate_hash:xdr.ScVal.scvBytes(Buffer.from(document.predicateHash,'hex'))})
 return new Contract(prime).call('add_context_rule',vec([sym('CallContract'),addr(scope)]),xdr.ScVal.scvString(name),xdr.ScVal.scvVoid(),vec([delegatedSigner(AGENT)]),xdr.ScVal.scvMap([new xdr.ScMapEntry({key:addr(INTERPRETER),val:params})]))
}
const scopes=[[executor,'mainnet-proof-exec'],[TOKEN,'mainnet-proof-token'],[POOL,'mainnet-proof-pool']] as const
const forecasts=[]
for(const [scope,name] of scopes)if(receipt.rules[scope]===undefined){
 const prepared=await preparePrime(ruleOperation(scope,name),OWNER,allOwner)
 forecasts.push({scope,name,maxFeeStroops:prepared.fee.toString()})
}
const forecastTotal=committedFees()+forecasts.reduce((n,x)=>n+BigInt(x.maxFeeStroops),0n)+PRINCIPAL+15_000_000n
receipt.remainingCostForecast={recordedAt:new Date().toISOString(),scopes:forecasts,postInstallReserveStroops:'15000000',projectedTotalIncludingPriorFeesAndPrincipal:forecastTotal.toString(),capStroops:TOTAL_CAP.toString()};save()
console.log('COST FORECAST',JSON.stringify(receipt.remainingCostForecast))
assert(forecastTotal<=TOTAL_CAP,'Remaining scope installs plus reserved completion budget exceed authorized cap')
for(const [scope,name] of scopes){
 const bounds=(await instance(prime))!.values
 const next=Number(bounds.get('NextId'));assert(Number.isSafeInteger(next)&&next<=8)
 let id:number|undefined
 for(let n=1;n<next;n++){const r=scValToNative(await view(prime,'get_context_rule',[u32(n)]));if(r.name===name){id=n;assert.deepEqual(r.signers,[['Delegated',AGENT]]);assert.deepEqual(r.policies,[INTERPRETER]);assert.deepEqual(r.context_type,['CallContract',scope])}}
 if(id===undefined){
  const op=ruleOperation(scope,name)
  await submit('install '+name,await preparePrime(op,OWNER,allOwner));id=next
 }
 const stored=await server.getLedgerEntries(docLedgerKey(INTERPRETER,prime,id))
 const bytes=stored.entries[0]&&decodeStoredPredicateBytes(stored.entries[0].val.contractData().val())
 assert(bytes);assert.equal(hash(bytes).toString('hex'),document.predicateHash)
 receipt.rules[scope!]=id;save()
}
assert.equal(Number((await instance(prime))!.values.get('Count')),4,'Unexpected competing rule')
receipt.checks.before??=await snapshot();save()
try {
if(!done('agent native supply')){
 assert.equal(receipt.checks.before.positions.supply.length,0,'Dedicated Prime must start with no position')
 assert.equal(await allowance(),0n)
 // Do not start a deposit if the remaining authorized budget cannot retain cleanup funds.
 assert(committedFees()+PRINCIPAL+CLEANUP_RESERVE<TOTAL_CAP,'Insufficient authorized cleanup budget')
 await approval(PRINCIPAL,'approve exact native principal')
}
 if(!done('agent native supply')){
  for(const [name,op] of [
   ['standalone custody pull',new Contract(TOKEN).call('transfer_from',addr(prime),addr(OWNER),addr(executor),int(PRINCIPAL))],
   ['unequal funding and supply',batch(true,PRINCIPAL-1n)],
  ] as const){
   let refusal=''
   try{await preparePrime(op,AGENT,agentRules)}catch(error){refusal=error instanceof Error?error.message:String(error)}
   assert(/#900|#903/.test(refusal),'Expected scoped policy denial for '+name+': '+refusal)
   receipt.checks[name]={denied:true,error:refusal.slice(0,2000),onLedger:false};save()
   console.log('DENIED BY POLICY',name)
  }
  const prepared=await preparePrime(batch(true),AGENT,agentRules)
  await submit('agent native supply',prepared,CLEANUP_RESERVE)
 }
 receipt.checks.afterSupply??=await snapshot();save()
 if(!done('agent native withdraw'))await submit('agent native withdraw',await preparePrime(batch(false),AGENT,agentRules))
 receipt.checks.afterWithdraw=await snapshot();save()
} finally {
 if(await allowance()!==0n||!done('revoke native allowance'))await approval(0n,'revoke native allowance')
}
const final=await snapshot();assert.equal(final.prime,'0');assert.equal(final.executor,'0');assert.equal(final.allowance,'0')
assert.equal(final.positions.supply.length,0);assert.equal(final.positions.collateral.length,0);assert.equal(final.positions.liabilities.length,0)
assert.equal((await view(prime,'get_context_rule',[u32(0)])).toXDR('base64'),receipt.ownerRuleXdr)
assert.equal((await funds(AGENT)).balance,agentFunds.balance,'Agent account paid a fee unexpectedly')
for(const [label,expected] of [['agent native supply',[[OWNER,executor,PRINCIPAL.toString()],[executor,POOL,PRINCIPAL.toString()]]],['agent native withdraw',null]] as const){
 const t=done(label);const transfers=t.events.filter((e:any)=>e.contract===TOKEN&&e.topics[0]==='transfer').map((e:any)=>[e.topics[1],e.topics[2],e.data])
 if(expected)assert.deepEqual(transfers,expected)
 else {assert.equal(transfers.length,1);assert.equal(transfers[0][0],POOL);assert.equal(transfers[0][1],OWNER);assert(BigInt(transfers[0][2])>0n&&BigInt(transfers[0][2])<AMOUNT_CAP)}
 t.verifiedTokenTransfers=transfers
}
receipt.checks.final=final;receipt.totalChargedFeesStroops=committedFees().toString();receipt.complete=true;receipt.completedAt=new Date().toISOString();save()
console.log('MAINNET PROOF COMPLETE',JSON.stringify({prime,executor,rules:receipt.rules,fees:receipt.totalChargedFeesStroops,final}))
