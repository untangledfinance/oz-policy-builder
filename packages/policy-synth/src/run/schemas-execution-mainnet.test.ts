import {describe,it,expect} from 'bun:test'
import {Address,xdr} from '@stellar/stellar-sdk'
import {collectObservedRules,type AccountRuleReader} from '../install/read-account-rules.ts'
import {encodeExecutionDocument} from '../install/scoped-execution.ts'
import {ADDITIONAL_AUTHORITY_INTERPRETERS_BY_NETWORK,PINNED_INTERPRETER_ADDRESS_BY_NETWORK} from './schemas.ts'
const MAINNET_V6='CCZDVEJOVQ2H5NDLDYLF6N47WDC2ZW7UTLY4Z5LCIL3ZMEHUMKNGW747'
const PRIME=Address.contract(Buffer.alloc(32,1)).toString()
const EXECUTOR=Address.contract(Buffer.alloc(32,2)).toString()
const TOKEN=Address.contract(Buffer.alloc(32,3)).toString()
const sym=(s:string)=>xdr.ScVal.scvSymbol(s)
const addr=(s:string)=>new Address(s).toScVal()
const encoded=encodeExecutionDocument({executor:EXECUTOR,plans:[{steps:[{predicate:{op:'eq',left:{kind:'call_contract'},right:{kind:'literal_address',value:TOKEN}},authorizations:[]}],equalities:[]}]})
function reader():AccountRuleReader {
 const rule=xdr.ScVal.scvMap([
  ['context_type',xdr.ScVal.scvVec([sym('CallContract'),addr(EXECUTOR)])],
  ['id',xdr.ScVal.scvU32(1)],
  ['policies',xdr.ScVal.scvVec([addr(MAINNET_V6)])],
  ['signers',xdr.ScVal.scvVec([])],
 ].map(([k,v])=>new xdr.ScMapEntry({key:sym(k as string),val:v as xdr.ScVal})))
 return {
  getContextRuleCount:async()=>1,
  getContextRule:async(_account,id)=>id===1?rule:undefined,
  getStoredDoc:async(interpreter)=>interpreter===MAINNET_V6?xdr.ScVal.scvMap([new xdr.ScMapEntry({key:sym('predicate_bytes'),val:xdr.ScVal.scvBytes(Buffer.from(encoded.encodedPredicate,'base64'))})]):undefined,
 }
}
async function collect(network:'mainnet'|'testnet') {
 return collectObservedRules({reader:reader(),smartAccount:PRIME,interpreterAddress:PINNED_INTERPRETER_ADDRESS_BY_NETWORK[network],additionalInterpreterAddresses:ADDITIONAL_AUTHORITY_INTERPRETERS_BY_NETWORK[network],maxRuleIdScan:3})
}
describe('mainnet execution authority discovery pins',()=>{
 it('recognizes stored mainnet v6 authority while retaining the legacy default interpreter',async()=>{
  const result=await collect('mainnet')
  expect(result.incomplete).toBe(false)
  expect(result.rules[0]?.executionDocument?.executor).toBe(EXECUTOR)
  expect(result.rules[0]?.executionDocumentHash).toBe(encoded.predicateHash)
  expect(PINNED_INTERPRETER_ADDRESS_BY_NETWORK.mainnet).not.toBe(MAINNET_V6)
 })
 it('does not trust the mainnet deployment in a testnet authority scan',async()=>{
  const result=await collect('testnet')
  expect(result.rules[0]?.executionDocument).toBeUndefined()
  expect(result.rules[0]?.policyAddresses).toEqual([MAINNET_V6])
 })
})
