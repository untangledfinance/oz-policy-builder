// Regenerate from repo root: bun contracts/execution-adapter/tests/generate-projection-fixtures.ts
// Shared bytes pin TypeScript/Rust agreement, including every supported scalar category.
import { mkdirSync, writeFileSync } from 'node:fs'
import { Address, StrKey, nativeToScVal as sc, xdr } from '@stellar/stellar-sdk'
import {
  buildExecutionBatchPolicy,
  projectExecutionRequest,
} from '../../../packages/policy-synth/src/install/execution-batch.ts'

const address = (n: number) => new Address(StrKey.encodeContract(Buffer.alloc(32, n))).toScVal()
const map = (fields: Record<string, xdr.ScVal>) =>
  xdr.ScVal.scvMap(
    Object.entries(fields)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v }))
  )
const call = map({
  args: xdr.ScVal.scvVec([
    address(1),
    sc(7n, { type: 'i128' }),
    sc(1n << 80n, { type: 'i128' }),
    xdr.ScVal.scvBool(true),
    xdr.ScVal.scvBytes(Buffer.from([1, 2, 3])),
    xdr.ScVal.scvString('literal'),
    sc(1n << 60n, { type: 'u64' }),
    xdr.ScVal.scvSymbol('long_symbol_value'),
    xdr.ScVal.scvVec([]),
    map({ amount: sc(-2n, { type: 'i128' }), request_type: xdr.ScVal.scvU32(0) }),
  ]),
  executor_authorizations: xdr.ScVal.scvVec([
    xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol('Contract'),
      map({
        context: map({
          args: xdr.ScVal.scvVec([address(3), address(4), sc(7n, { type: 'i128' })]),
          contract: address(5),
          fn_name: xdr.ScVal.scvSymbol('transfer'),
        }),
        sub_invocations: xdr.ScVal.scvVec([]),
      }),
    ]),
  ]),
  function_name: xdr.ScVal.scvSymbol('submit'),
  target: address(4),
})
const request = xdr.ScVal.scvVec([
  address(1),
  address(2),
  xdr.ScVal.scvVec([call]),
  xdr.ScVal.scvVec([]),
])
const dir = new URL('./fixtures/', import.meta.url)
mkdirSync(dir, { recursive: true })
writeFileSync(new URL('projection-request.xdr', dir), request.toXDR())
writeFileSync(
  new URL('projection-args.xdr', dir),
  xdr.ScVal.scvVec(projectExecutionRequest(request)).toXDR()
)
writeFileSync(
  new URL('projection-policy.xdr', dir),
  Buffer.from(buildExecutionBatchPolicy(request).encodedPredicate, 'base64')
)
