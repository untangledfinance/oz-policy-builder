// Tests for the untrusted-JSON predicate parser.
//
// This is the gate a hand-written policy passes through before it reaches
// the encoder, so the cases that matter are the REJECTIONS: a parser that
// accepts a malformed shape hands the encoder something it was never meant
// to see. It had no tests while it lived in the demo app.

import { describe, expect, it } from 'bun:test'
import { encodePredicate } from './encode.ts'
import { jsonToAst } from './from-json.ts'

const ADDR = 'CDAWEE6CFKZCQJ4JGQBRXMPVJ2PRL3A3F6DJWEMOCNJLMVX32FAVHXY3'

describe('jsonToAst - accepts', () => {
  it('a contract-scope equality', () => {
    const ast = jsonToAst({
      op: 'eq',
      left: { kind: 'call_contract' },
      right: { kind: 'literal_address', value: ADDR },
    })
    expect(ast.op).toBe('eq')
  })

  it('an and-node with children', () => {
    const ast = jsonToAst({
      op: 'and',
      children: [
        {
          op: 'eq',
          left: { kind: 'call_fn' },
          right: { kind: 'literal_symbol', value: 'transfer' },
        },
        {
          op: 'lte',
          left: { kind: 'call_arg', index: 2 },
          right: { kind: 'literal_i128', value: '100' },
        },
      ],
    })
    expect(ast.op).toBe('and')
  })

  // The slippage-floor leaf. The parser lived in the demo app and was not
  // updated when the leaf shipped, so a pasted floor policy was rejected by
  // the tooling while the contract accepted it.
  it('a call_arg_scaled slippage floor', () => {
    const ast = jsonToAst({
      op: 'gte',
      left: { kind: 'call_arg', index: 1 },
      right: { kind: 'call_arg_scaled', index: 0, num: '95', den: '100' },
    })
    expect(ast.op).toBe('gte')
    // and it must survive the encoder, not just the parser
    expect(encodePredicate(ast).encodedPredicate.length).toBeGreaterThan(0)
  })

  it('num/den beyond 2^53 without precision loss', () => {
    const big = '170141183460469231731687303715884105727'
    const ast = jsonToAst({
      op: 'gte',
      left: { kind: 'call_arg', index: 1 },
      right: { kind: 'call_arg_scaled', index: 0, num: big, den: '1' },
    })
    const right = (ast as { right: { num: string } }).right
    expect(right.num).toBe(big)
  })
})

describe('jsonToAst - rejects', () => {
  it('a non-object', () => {
    expect(() => jsonToAst(null)).toThrow()
    expect(() => jsonToAst('and')).toThrow()
    expect(() => jsonToAst(42)).toThrow()
  })

  it('an unknown operator', () => {
    expect(() => jsonToAst({ op: 'nand', children: [] })).toThrow()
  })

  it('an unknown leaf kind', () => {
    expect(() =>
      jsonToAst({
        op: 'eq',
        left: { kind: 'call_gas' },
        right: { kind: 'literal_symbol', value: 'x' },
      })
    ).toThrow(/unknown leaf kind/)
  })

  it('a non-integer index', () => {
    expect(() =>
      jsonToAst({
        op: 'eq',
        left: { kind: 'call_arg', index: 1.5 },
        right: { kind: 'literal_symbol', value: 'x' },
      })
    ).toThrow(/must be an integer/)
  })

  it('a numeric num/den on call_arg_scaled', () => {
    // A JSON number here is the precision bug this shape exists to avoid.
    expect(() =>
      jsonToAst({
        op: 'gte',
        left: { kind: 'call_arg', index: 1 },
        right: { kind: 'call_arg_scaled', index: 0, num: 95, den: 100 },
      })
    ).toThrow(/must be a string/)
  })

  it('children that are not an array', () => {
    expect(() => jsonToAst({ op: 'and', children: 'nope' })).toThrow(/expected array/)
  })

  it('a leaf where a node was expected', () => {
    expect(() => jsonToAst({ kind: 'call_contract' })).toThrow()
  })
})
