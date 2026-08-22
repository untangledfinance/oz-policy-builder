// Tests for the untrusted-JSON predicate parser.
//
// This is the gate a hand-written policy passes through before it reaches
// the encoder, so the cases that matter are the REJECTIONS: a parser that
// accepts a malformed shape hands the encoder something it was never meant
// to see. It had no tests while it lived in the demo app.

import { describe, expect, it } from 'bun:test'
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

  it('children that are not an array', () => {
    expect(() => jsonToAst({ op: 'and', children: 'nope' })).toThrow(/expected array/)
  })

  it('a leaf where a node was expected', () => {
    expect(() => jsonToAst({ kind: 'call_contract' })).toThrow()
  })
})

describe('jsonToAst - leaves that were previously unreachable', () => {
  it('parses call_arg_field, so a structured-argument bind round-trips', () => {
    // Absent until now: the leaf existed in the grammar and the encoder, but
    // a predicate carrying it could not be rebuilt from JSON at all.
    const node = jsonToAst({
      op: 'eq',
      left: { kind: 'call_arg_field', index: 1, element: 0, field: 'address' },
      right: { kind: 'literal_u32', value: 7 },
    })
    expect(node).toEqual({
      op: 'eq',
      left: { kind: 'call_arg_field', index: 1, element: 0, field: 'address' },
      right: { kind: 'literal_u32', value: 7 },
    })
  })

  it('rejects a call_arg_field missing its field name', () => {
    expect(() =>
      jsonToAst({
        op: 'eq',
        left: { kind: 'call_arg_field', index: 1, element: 0 },
        right: { kind: 'literal_u32', value: 7 },
      })
    ).toThrow()
  })

  it('parses call_arg_scaled with i128 ratios as strings', () => {
    const node = jsonToAst({
      op: 'gte',
      left: { kind: 'call_arg', index: 1 },
      right: { kind: 'call_arg_scaled', index: 0, num: '99', den: '100' },
    })
    expect(node).toEqual({
      op: 'gte',
      left: { kind: 'call_arg', index: 1 },
      right: { kind: 'call_arg_scaled', index: 0, num: '99', den: '100' },
    })
  })

  it('parses or', () => {
    const node = jsonToAst({
      op: 'or',
      children: [
        { op: 'eq', left: { kind: 'call_fn' }, right: { kind: 'literal_symbol', value: 'a' } },
        { op: 'eq', left: { kind: 'call_fn' }, right: { kind: 'literal_symbol', value: 'b' } },
      ],
    })
    expect(node.op).toBe('or')
  })
})
