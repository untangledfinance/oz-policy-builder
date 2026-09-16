/** Owner-authorized deployment funding. Default read-only; native XLM only.
 * Private signing material is read in memory and never written or logged. */
import {Asset,Horizon,Keypair,Networks,Operation,TransactionBuilder,rpc} from '@stellar/stellar-sdk';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const destination='GCIVG2AIEWMDA43HX2HRCYVNY7PH7HMPYVN42LQ5XBSHBLHFUWG47NFN';
const target=1_140_000_000n, maxMove=260_000_000n;
const horizon=new Horizon.Server('https://horizon.stellar.org');
const rpcServer=new rpc.Server('https://mainnet.sorobanrpc.com');
const execute=process.argv.includes('--execute');
if(process.argv.slice(2).some(x=>x!=='--execute'))throw Error('Unknown option');
const root='/home/ubuntu/git/github.com/untangledfinance/';
const sources=[
 {name:'mainnet agent',address:'GCTI2WE25C3Z4CUQXKT6RSAC4NS7M7BBVLR5PM7VS6OKYQPOABLJSMXE',file:'octogate/.env',variable:'MAINNET_SA_AGENT_SECRET',buffer:2_500_000n},
 {name:'UNT issuer',address:'GAYBI4VSAX232IYQEYHDA2F2JIMNSHIF2MCH7LG6WSYZDZBWGEHCSQIT',identity:'unt-mainnet-issuer',buffer:2_500_000n},
 {name:'deployment funding',address:'GBXN4MWMQZZIHH3WKCUDJDLCJ6TTYVRBJ2Q2R7WY2CJ7FSW3QPPYT4J5',identity:'mainnet_funding',buffer:2_500_000n},
 {name:'cosign fixture A',address:'GDNY27EO275GW7SG2EQVLD7VR65X73376VB6BWO4XQT4UBHWTXI2H4QP',file:'octopos/.env',variable:'MAINNET_COSIGN_SIGNER_A',buffer:2_500_000n},
 {name:'cosign fixture B',address:'GCGTQOK7BYCLAYTG4UU2PZ3DEMK4V6JAIQ3IDXVPTXEO66YZAWBFKENH',file:'octopos/.env',variable:'MAINNET_COSIGN_SIGNER_B',buffer:2_500_000n},
 {name:'UNT distributor',address:'GCW2X63VQTR4JG6573YLVOR342KAQ4ZTHMTASQBSAK3H6HK2RJCICVR5',identity:'unt-mainnet-distributor',buffer:2_500_000n},
 {name:'RMS facilitator',address:'GA5VQFVG4NEKE3SQ6UOTHLQDFH4TJOHDS6DPV2L5ZHEHZCXB62BU5YBQ',file:'rms/.env',variable:'X402_FACILITATOR_STELLAR_SECRET_KEY',buffer:10_000_000n},
];
const amount=(s:string)=>{const [a,b='']=s.split('.');return BigInt(a!)*10_000_000n+BigInt(b.padEnd(7,'0'));};
const xlm=(n:bigint)=>`${n/10_000_000n}.${(n%10_000_000n).toString().padStart(7,'0')}`;
const receiptPath='docs/audit/evidence/mainnet-funding-consolidation.json';
const receipt:any=existsSync(receiptPath)?JSON.parse(readFileSync(receiptPath,'utf8')):{network:Networks.PUBLIC,destination,transactions:[]};
if(receipt.network!==Networks.PUBLIC||receipt.destination!==destination)throw Error('Receipt identity mismatch');
const save=()=>{mkdirSync('docs/audit/evidence',{recursive:true});writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n');};
if((await rpcServer.getNetwork()).passphrase!==Networks.PUBLIC)throw Error('Wrong network');
const ledgers=await horizon.ledgers().order('desc').limit(1).call();
const reserve=BigInt(ledgers.records[0]!.base_reserve_in_stroops);
const fee=BigInt(ledgers.records[0]!.base_fee_in_stroops);
if(fee>10_000n)throw Error('Unexpected classic base fee');
function native(a:any){return a.balances.find((b:any)=>b.asset_type==='native');}
function bounds(a:any){const n=native(a);const minimum=reserve*BigInt(2+a.subentry_count+(a.num_sponsoring??0)-(a.num_sponsored??0));return {balance:amount(n.balance),minimum,available:amount(n.balance)-minimum-amount(n.selling_liabilities)};}
for(const tx of receipt.transactions){if(tx.status==='SUCCESS')continue;try{const confirmed=await horizon.transactions().transaction(tx.hash).call();if(!confirmed.successful)throw Error('Previous funding transaction failed');tx.status='SUCCESS';tx.ledger=confirmed.ledger;if(execute)save();}catch{throw Error('Resolve pending funding receipt before retry: '+tx.hash);}}
let moved=receipt.transactions.reduce((n:bigint,t:any)=>n+amount(t.amountXlm),0n);
let dest= bounds(await horizon.loadAccount(destination)).balance;
const plan:any[]=[];
for(const source of sources){
 if(dest>=target)break;
 const a=await horizon.loadAccount(source.address);const b=bounds(a);
 const self=a.signers.find(s=>s.key===source.address);
 if(!self||self.weight<Math.max(1,a.thresholds.med_threshold))throw Error('Source needs additional signer consent: '+source.name);
 let send=b.available-source.buffer-fee;
 if(send<=0n)continue;
 if(send>target-dest)send=target-dest;
 if(moved+send>maxMove)throw Error('Consolidation exceeds 26 XLM cap');
 const item:any={source:source.address,label:source.name,destination,amountXlm:xlm(send),minimumReserveXlm:xlm(b.minimum),retainedBalanceXlm:xlm(b.balance-send-fee)};
 plan.push(item);
 if(execute){
  const tx=new TransactionBuilder(a,{fee:fee.toString(),networkPassphrase:Networks.PUBLIC}).addOperation(Operation.payment({destination,asset:Asset.native(),amount:xlm(send)})).setTimeout(180).build();
  if(source.identity){
   const signed=spawnSync('/home/ubuntu/.local/bin/stellar',['tx','sign','--sign-with-key',source.identity,'--network-passphrase',Networks.PUBLIC],{input:tx.toXDR(),encoding:'utf8'});
   if(signed.status!==0)throw Error('CLI signing failed for '+source.name);
   const parsed=TransactionBuilder.fromXDR(signed.stdout.trim(),Networks.PUBLIC);
   if(!parsed.hash().equals(tx.hash()))throw Error('Signed transaction changed');
   for(const sig of parsed.signatures)tx.signatures.push(sig);
  }else{
   const line=readFileSync(root+source.file!,'utf8').split('\n').find(l=>new RegExp('^\\s*(?:export\\s+)?'+source.variable+'\\s*=').test(l));
   const value=line?.slice(line.indexOf('=')+1).match(/\bS[A-Z2-7]{55}\b/)?.[0];
   if(!value)throw Error('Configured signing key unavailable for '+source.name);
   const key=Keypair.fromSecret(value);if(key.publicKey()!==source.address)throw Error('Signing identity mismatch');
   tx.sign(key);
  }
  if(!tx.signatures.some(s=>Keypair.fromPublicKey(source.address).verify(tx.hash(),s.signature())))throw Error('Signature check failed');
  item.hash=tx.hash().toString('hex');item.status='READY';receipt.transactions.push(item);save();
  let confirmed;
  try{confirmed=await horizon.submitTransaction(tx);}catch{throw Error('Broadcast uncertain; inspect receipt '+item.hash);}
  if(!confirmed.successful||confirmed.hash!==item.hash)throw Error('Funding transaction failed');
  item.status='SUCCESS';item.ledger=confirmed.ledger;save();
  const after=bounds(await horizon.loadAccount(source.address));
  if(after.available<source.buffer)throw Error('Retained source buffer check failed');
  dest=bounds(await horizon.loadAccount(destination)).balance;
  console.log(JSON.stringify(item));
 }else dest+=send;
 moved+=send;
}
receipt.finalBalanceXlm=xlm(dest);receipt.updatedAt=new Date().toISOString();if(execute)save();
console.log(JSON.stringify({mode:execute?'execute':'read-only',targetXlm:xlm(target),projectedBalanceXlm:xlm(dest),movedXlm:xlm(moved),plan},null,2));
