import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk'
import { buildExecutionBatchPolicy, projectExecutionRequest } from './execution-batch.ts'

const address = new Address('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF').toScVal()
const request = xdr.ScVal.scvVec([
  address,
  address,
  xdr.ScVal.scvVec([nativeToScVal(7n, { type: 'i128' }), xdr.ScVal.scvSymbol('claim')]),
  xdr.ScVal.scvVec([]),
])
describe('execution batch projection', () => {
  it('exposes exact scalar leaves and commits to container boundaries', () => {
    const args = projectExecutionRequest(request)
    expect(args.slice(2).map((v) => v.toXDR('base64'))).toEqual(
      [address, address, nativeToScVal(7n, { type: 'i128' }), xdr.ScVal.scvSymbol('claim')].map(
        (v) => v.toXDR('base64')
      )
    )
    const rearranged = xdr.ScVal.scvVec([
      address,
      address,
      xdr.ScVal.scvVec([]),
      request.vec()![2]!,
    ])
    expect(projectExecutionRequest(rearranged)[0]!.toXDR('base64')).not.toEqual(
      args[0]!.toXDR('base64')
    )
  })
  it('keeps semantic shape when an i128 crosses the small-object threshold', () => {
    const large = xdr.ScVal.scvVec([
      address,
      address,
      xdr.ScVal.scvVec([nativeToScVal(1n << 80n, { type: 'i128' }), xdr.ScVal.scvSymbol('claim')]),
      xdr.ScVal.scvVec([]),
    ])
    expect(
      projectExecutionRequest(large)
        .slice(0, 2)
        .map((v) => v.toXDR('base64'))
    ).toEqual(
      projectExecutionRequest(request)
        .slice(0, 2)
        .map((v) => v.toXDR('base64'))
    )
  })
  it('pins unsupported scalar types instead of ignoring them', () => {
    const project = (b: boolean) =>
      projectExecutionRequest(
        xdr.ScVal.scvVec([
          address,
          address,
          xdr.ScVal.scvVec([xdr.ScVal.scvBool(b)]),
          xdr.ScVal.scvVec([]),
        ])
      )
    expect(
      project(true)
        .slice(-2)
        .map((v) => v.toXDR('base64'))
    ).not.toEqual(
      project(false)
        .slice(-2)
        .map((v) => v.toXDR('base64'))
    )
  })
  it('builds an existing-v5 predicate and refuses structural slots as variable amounts', () => {
    const fixed = buildExecutionBatchPolicy(request)
    expect(fixed.encodedPredicate.length).toBeGreaterThan(0)
    expect(() =>
      buildExecutionBatchPolicy(request, [{ slots: [0], min: '1', maxExclusive: '10' }])
    ).toThrow()
    expect(() =>
      buildExecutionBatchPolicy(request, [{ slots: [2], min: '1', maxExclusive: '10' }])
    ).toThrow()
    expect(
      buildExecutionBatchPolicy(request, [{ slots: [4], min: '1', maxExclusive: '10' }])
        .encodedPredicate
    ).not.toEqual(fixed.encodedPredicate)
  })
})

it('matches the shared Rust projection fixture bytes', () => {
  const dir = new URL('../../../../contracts/execution-adapter/tests/fixtures/', import.meta.url)
  const request = xdr.ScVal.fromXDR(readFileSync(new URL('projection-request.xdr', dir)))
  expect(xdr.ScVal.scvVec(projectExecutionRequest(request)).toXDR('base64')).toBe(
    readFileSync(new URL('projection-args.xdr', dir)).toString('base64')
  )
})
