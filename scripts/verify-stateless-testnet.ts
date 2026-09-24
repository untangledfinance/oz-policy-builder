// Read-only verification of public deployment evidence. No private keys required.

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  Address,
  Contract,
  Networks,
  rpc,
  StrKey,
  scValToNative,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'

const path = 'docs/stateless-execution-testnet.json'
const evidence = JSON.parse(readFileSync(path, 'utf8'))
assert.equal(evidence.network, 'TESTNET')
assert.equal(evidence.rpc, 'https://soroban-testnet.stellar.org')
const server = new rpc.Server(evidence.rpc)
const receipts: any[] = []
for (let start = 0; start < evidence.transactions.length; start += 5) {
  await Promise.all(
    evidence.transactions.slice(start, start + 5).map(async (record: any) => {
      const tx = await server.getTransaction(record.hash)
      assert.equal(tx.status, record.status, record.label)
      assert(tx.status === 'SUCCESS' || tx.status === 'FAILED')
      assert.equal(tx.ledger, record.ledger)
      const entry: any = {
        label: record.label,
        hash: record.hash,
        status: tx.status,
        ledger: tx.ledger,
      }
      if (tx.status === 'FAILED') {
        assert.equal(record.label, 'failed batch rolls back')
        entry.fixtureDiagnostics = (tx.diagnosticEventsXdr ?? []).flatMap((d) => {
          const event = d.event(),
            id = event.contractId()
          if (
            !id ||
            StrKey.encodeContract(Buffer.from(id as unknown as Uint8Array)) !==
              evidence.contracts.fixture
          )
            return []
          let data: unknown
          try {
            data = scValToNative(event.body().v0().data())
          } catch {
            data = event.body().v0().data().toXDR('base64')
          }
          return [
            { data: JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) },
          ]
        })
        assert(
          entry.fixtureDiagnostics.some((d: any) => d.data.includes('UnreachableCodeReached')),
          'failure must reach the deliberate venue trap'
        )
        entry.resultXdr = tx.resultXdr.toXDR('base64')
      }
      receipts.push(entry)
    })
  )
}
const instances: any = {}
for (const name of ['prime', 'interpreter', 'adapter']) {
  const address = evidence.contracts[name]
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(address).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  )
  const result = await server.getLedgerEntries(key)
  assert.equal(result.entries.length, 1)
  const instance = result.entries[0]!.val.contractData().val().instance()
  const wasmHash = instance.executable().wasmHash().toString('hex')
  assert.equal(wasmHash, evidence.wasmHashes[name === 'prime' ? 'oz-account' : name])
  instances[name] = {
    address,
    wasmHash,
    storageEntries: instance.storage()?.length ?? 0,
    observedLedger: result.latestLedger,
  }
}
assert.equal(instances.adapter.storageEntries, 0)
const addr = (a: string) => new Address(a).toScVal()
async function view(contract: string, fn: string, args: xdr.ScVal[] = []) {
  const tx = new TransactionBuilder(await server.getAccount(evidence.agent), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(new Contract(contract).call(fn, ...args))
    .setTimeout(60)
    .build()
  const sim = await server.simulateTransaction(tx)
  assert(!rpc.Api.isSimulationError(sim), 'view failed')
  assert(sim.result)
  return scValToNative(sim.result.retval)
}
assert.equal(await view(evidence.token, 'balance', [addr(evidence.contracts.prime)]), 0n)
assert.equal(await view(evidence.token, 'balance', [addr(evidence.contracts.adapter)]), 0n)
assert.equal(
  await view(evidence.token, 'allowance', [addr(evidence.owner), addr(evidence.contracts.prime)]),
  0n
)
assert.equal(
  await view(evidence.token, 'allowance', [addr(evidence.owner), addr(evidence.contracts.adapter)]),
  0n
)
const position: any = await view(evidence.pool, 'get_positions', [addr(evidence.contracts.prime)])
const shares =
  position.supply instanceof Map
    ? [...position.supply.values()]
    : Object.values(position.supply ?? {})
assert(shares.every((x: any) => BigInt(x) === 0n))
const output = {
  network: 'TESTNET',
  verifiedAt: new Date().toISOString(),
  receipts: receipts.sort((a, b) => a.ledger - b.ledger),
  instances,
  balancesAndAllowancesZero: true,
  positionClosed: true,
}
writeFileSync(
  'docs/stateless-execution-testnet-verification.json',
  JSON.stringify(output, null, 2) + '\n'
)
console.log(
  JSON.stringify(
    {
      receiptCount: receipts.length,
      instances,
      balancesAndAllowancesZero: true,
      positionClosed: true,
    },
    null,
    2
  )
)
