import { describe, expect, it } from 'bun:test'
import type { ContractInvocation } from '../types.ts'
import { composeFromRecording } from './compose-from-recording.ts'
import type { IntentFacts } from './lower.ts'

const SEP41_TOKEN = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'
const BLEND_POOL = 'CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU'
const SOROSWAP_ROUTER = 'CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH'
const XLM_TOKEN = 'CAS3J7GYLGXMF6TDJ5WQ2PEN4GRVNXJUIQ2TZU3ZB3OQ2V4DRCWI7WPF'
const USDC_TOKEN = 'CCWCLTASNDT57N3BCHOSVB5QWMV5URK4BXLDDF6ZZQYMBQ4OKZA3ZB2N'
const G_OWNER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACFD'

function sep41TopLevel(to = 'GBILLER'): ContractInvocation {
  return {
    contract: SEP41_TOKEN,
    fn: 'transfer',
    args: [
      { type: 'address', value: G_OWNER },
      { type: 'address', value: to },
      { type: 'i128', value: '1000000000' },
    ],
    subInvocations: [],
  }
}

function sep41Facts(): IntentFacts {
  return {
    callTargets: [SEP41_TOKEN],
    functionsByContract: { [SEP41_TOKEN]: ['transfer'] },
    spendByToken: { [SEP41_TOKEN]: '1000000000' },
    signers: [G_OWNER],
  }
}

function blendFacts(): IntentFacts {
  return {
    callTargets: [BLEND_POOL],
    functionsByContract: { [BLEND_POOL]: ['claim'] },
    spendByToken: {},
    signers: [G_OWNER],
  }
}

function blendTopLevel(): ContractInvocation {
  return {
    contract: BLEND_POOL,
    fn: 'claim',
    args: [
      { type: 'address', value: G_OWNER },
      { type: 'vec', value: [{ type: 'u32', value: '0' }] },
      { type: 'address', value: G_OWNER },
    ],
    subInvocations: [],
  }
}

function soroswapTopLevel(): ContractInvocation {
  return {
    contract: SOROSWAP_ROUTER,
    fn: 'swap_exact_tokens_for_tokens',
    args: [
      { type: 'i128', value: '50000000' },
      { type: 'i128', value: '45000000' },
      {
        type: 'vec',
        value: [
          { type: 'address', value: XLM_TOKEN },
          { type: 'address', value: USDC_TOKEN },
        ],
      },
      { type: 'address', value: G_OWNER },
      { type: 'u64', value: '1700000000' },
    ],
    subInvocations: [],
  }
}

function soroswapFacts(): IntentFacts {
  return {
    callTargets: [SOROSWAP_ROUTER],
    functionsByContract: { [SOROSWAP_ROUTER]: ['swap_exact_tokens_for_tokens'] },
    spendByToken: { [XLM_TOKEN]: '50000000' },
    signers: [G_OWNER],
    allowedPaths: { [SOROSWAP_ROUTER]: [[XLM_TOKEN, USDC_TOKEN]] },
  }
}

/** Unknown protocol: a pinned-looking but unrecognised contract + method. */
function unknownTopLevel(): ContractInvocation {
  return {
    contract: 'CUNKNOWNCONTRACTADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    fn: 'do_something',
    args: [{ type: 'address', value: G_OWNER }],
    subInvocations: [],
  }
}

describe('composeFromRecording - carries the recorded method into scope (C1)', () => {
  it('sets rule.scope.method from the recorded top-level fn for every fixture', () => {
    const sep41 = composeFromRecording(sep41Facts(), SEP41_TOKEN, sep41TopLevel(), {
      network: 'mainnet',
      userResponses: { limitAmount: '1000000000' },
    })
    expect(sep41.interpreterIr.rules[0]?.scope).toEqual({
      contract: SEP41_TOKEN,
      method: 'transfer',
    })

    const blend = composeFromRecording(blendFacts(), BLEND_POOL, blendTopLevel(), {
      network: 'mainnet',
    })
    expect(blend.interpreterIr.rules[0]?.scope.method).toBe('claim')

    const soroswap = composeFromRecording(soroswapFacts(), SOROSWAP_ROUTER, soroswapTopLevel(), {
      network: 'mainnet',
    })
    expect(soroswap.interpreterIr.rules[0]?.scope.method).toBe('swap_exact_tokens_for_tokens')
  })
})

describe('composeFromRecording - SEP-41 subscription (limit supplied)', () => {
  it('caps the transfer amount argument at the caller limit + pins the recipient', () => {
    const r = composeFromRecording(sep41Facts(), SEP41_TOKEN, sep41TopLevel(), {
      network: 'mainnet',
      userResponses: { limitAmount: '1000000000' },
    })
    expect(r.ambiguities).toEqual([])
    const rule = r.interpreterIr.rules[0]
    expect(rule).toBeDefined()
    if (!rule) return
    expect(rule.scope).toEqual({ contract: SEP41_TOKEN, method: 'transfer' })
    expect(rule.constraints.length).toBe(2)
    // SEP-41 transfer(from, to, amount): the limit binds call_arg[2].
    const spend = rule.constraints[0]
    expect(spend?.op).toBe('compare')
    if (spend?.op === 'compare') {
      expect(spend.compare.selector).toEqual({
        kind: 'arg',
        argIndex: 2,
        scalarType: 'i128',
      })
      expect(spend.compare.operator).toBe('lte')
      expect(spend.compare.value).toBe('1000000000')
    }
    // The recorded recipient (call_arg[1]) is pinned as a single-element allowlist.
    const recipient = rule.constraints[1]
    expect(recipient?.op).toBe('in')
    if (recipient?.op === 'in') {
      expect(recipient.selector).toEqual({ kind: 'arg', argIndex: 1, scalarType: 'address' })
    }
  })

  it('uses validUntilLedger from userResponses as rule.expiry', () => {
    const r = composeFromRecording(sep41Facts(), SEP41_TOKEN, sep41TopLevel(), {
      network: 'mainnet',
      userResponses: {
        limitAmount: '1000000000',
        validUntilLedger: 1000000,
      },
    })
    expect(r.interpreterIr.rules[0]?.expiry).toEqual({ validUntilLedger: 1000000 })
  })
})

describe('composeFromRecording - amount is an ambiguity, never an auto-ceiling (I1)', () => {
  it('surfaces AMOUNT_BOUND_MISSING with the observed amount and emits no cap when limit absent', () => {
    const r = composeFromRecording(sep41Facts(), SEP41_TOKEN, sep41TopLevel(), {
      network: 'mainnet',
      userResponses: {},
    })
    const amount = r.ambiguities.find((a) => a.code === 'AMOUNT_BOUND_MISSING')
    expect(amount).toBeDefined()
    expect(amount?.question).toContain('1000000000')
    const rule = r.interpreterIr.rules[0]
    expect(rule).toBeDefined()
    if (!rule) return
    const hasAmountCap = rule.constraints.some(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'arg'
    )
    expect(hasAmountCap).toBe(false)
  })
})

describe('composeFromRecording - never silently omits a spent token (C2)', () => {
  it('two-token outgoing flow surfaces AMOUNT_BOUND_MISSING per token, no silent omission', () => {
    const facts: IntentFacts = {
      callTargets: [SOROSWAP_ROUTER],
      functionsByContract: { [SOROSWAP_ROUTER]: ['swap_exact_tokens_for_tokens'] },
      spendByToken: { [XLM_TOKEN]: '50000000', [USDC_TOKEN]: '45000000' },
      signers: [G_OWNER],
    }
    const r = composeFromRecording(facts, SOROSWAP_ROUTER, soroswapTopLevel(), {
      network: 'mainnet',
      userResponses: { limitAmount: '50000000' },
    })
    const amountBounds = r.ambiguities.filter((a) => a.code === 'AMOUNT_BOUND_MISSING')
    // A single caller limit cannot disambiguate two tokens -> one prompt per token.
    expect(amountBounds.length).toBe(2)
    expect(amountBounds.some((a) => a.question.includes(XLM_TOKEN))).toBe(true)
    expect(amountBounds.some((a) => a.question.includes(USDC_TOKEN))).toBe(true)
    // No amount cap compiled from an ambiguous multi-token spend.
    const spends = r.interpreterIr.rules[0]?.constraints.filter(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'arg'
    )
    expect(spends?.length).toBe(0)
  })

  it('two-token outgoing flow with no limitAmount emits no bound', () => {
    // A multi-token spend cannot bind a single caller limit, so the flow must
    // fail closed: no amount cap, one AMOUNT_BOUND_MISSING per token.
    const facts: IntentFacts = {
      callTargets: [SOROSWAP_ROUTER],
      functionsByContract: { [SOROSWAP_ROUTER]: ['swap_exact_tokens_for_tokens'] },
      spendByToken: { [XLM_TOKEN]: '50000000', [USDC_TOKEN]: '45000000' },
      signers: [G_OWNER],
    }
    const r = composeFromRecording(facts, SOROSWAP_ROUTER, soroswapTopLevel(), {
      network: 'mainnet',
      userResponses: {},
    })
    const rule = r.interpreterIr.rules[0]
    expect(rule).toBeDefined()
    if (!rule) return
    const hasSpend = rule.constraints.some(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'arg'
    )
    expect(hasSpend).toBe(false)
    const amountBounds = r.ambiguities.filter((a) => a.code === 'AMOUNT_BOUND_MISSING')
    expect(amountBounds.length).toBe(2)
  })
})

describe('composeFromRecording - Blend yield-claim (incoming only, I2)', () => {})

describe('composeFromRecording - SoroSwap swap: no fabricated constraints (I2)', () => {
  it('caps the input-amount arg at the caller limit and records the exact hop path', () => {
    const r = composeFromRecording(soroswapFacts(), SOROSWAP_ROUTER, soroswapTopLevel(), {
      network: 'mainnet',
      userResponses: { limitAmount: '50000000' },
    })
    const rule = r.interpreterIr.rules[0]
    expect(rule).toBeDefined()
    if (!rule) return
    // 1. SoroSwap names its input `amount_in`, not `amount`, so the limit binds
    //    the swap's own input arg (call_arg[0]). The caller supplied the bound,
    //    so it is answered, not surfaced as AMOUNT_BOUND_MISSING.
    const argCompare = rule.constraints.find(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'arg'
    )
    expect(argCompare).toBeDefined()
    if (argCompare?.op === 'compare' && argCompare.compare.selector.kind === 'arg') {
      expect(argCompare.compare.selector.argIndex).toBe(0)
      expect(argCompare.compare.operator).toBe('lte')
      expect(argCompare.compare.value).toBe('50000000')
    }
    expect(r.ambiguities.some((a) => a.code === 'AMOUNT_BOUND_MISSING')).toBe(false)
    // 2. The exact hop path is recorded as an eq_seq node on call_arg[2].
    const eqSeq = rule.constraints.find((c) => c.op === 'eq_seq')
    expect(eqSeq).toBeDefined()
    if (eqSeq && eqSeq.op === 'eq_seq') {
      expect(eqSeq.values).toEqual([XLM_TOKEN, USDC_TOKEN])
    }
  })
})

/** Fee-sponsored / holder != source: the input token never moved FROM the
 *  recorded source account, so lower() attributes no outgoing spend. The hop
 *  path is still recorded (it is an arg on the top-level call). */
function soroswapFactsNoSpend(): IntentFacts {
  return {
    callTargets: [SOROSWAP_ROUTER],
    functionsByContract: { [SOROSWAP_ROUTER]: ['swap_exact_tokens_for_tokens'] },
    spendByToken: {},
    signers: [G_OWNER],
    allowedPaths: { [SOROSWAP_ROUTER]: [[XLM_TOKEN, USDC_TOKEN]] },
  }
}

/** swap_tokens_for_exact_tokens: args = [amount_out, amount_in_max, path, to,
 *  deadline]. The INPUT (amount_in_max) is arg[1]; arg[0] is the exact output. */
function swapTokensForExactTopLevel(): ContractInvocation {
  return {
    contract: SOROSWAP_ROUTER,
    fn: 'swap_tokens_for_exact_tokens',
    args: [
      { type: 'i128', value: '45000000' }, // amount_out
      { type: 'i128', value: '50000000' }, // amount_in_max
      {
        type: 'vec',
        value: [
          { type: 'address', value: XLM_TOKEN },
          { type: 'address', value: USDC_TOKEN },
        ],
      },
      { type: 'address', value: G_OWNER },
      { type: 'u64', value: '1700000000' },
    ],
    subInvocations: [],
  }
}

/** swap_exact_in_for_tokens: args = [amount_in, amount_out_min, path, to] (no
 *  deadline). The INPUT (amount_in) is arg[0]. */
function swapExactInTopLevel(): ContractInvocation {
  return {
    contract: SOROSWAP_ROUTER,
    fn: 'swap_exact_in_for_tokens',
    args: [
      { type: 'i128', value: '50000000' }, // amount_in
      { type: 'i128', value: '45000000' }, // amount_out_min
      {
        type: 'vec',
        value: [
          { type: 'address', value: XLM_TOKEN },
          { type: 'address', value: USDC_TOKEN },
        ],
      },
      { type: 'address', value: G_OWNER },
    ],
    subInvocations: [],
  }
}

describe('composeFromRecording - SoroSwap input-amount cap on call_arg[0] (no detected spend)', () => {
  it('binds limitAmount to call_arg[0] as an lte compare', () => {
    const r = composeFromRecording(soroswapFactsNoSpend(), SOROSWAP_ROUTER, soroswapTopLevel(), {
      network: 'mainnet',
      userResponses: { limitAmount: '50000000' },
    })
    const interpRule = r.interpreterIr.rules[0]
    expect(interpRule).toBeDefined()
    if (!interpRule) return
    const argCap = interpRule.constraints.find(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'arg'
    )
    expect(argCap).toBeDefined()
    if (argCap && argCap.op === 'compare' && argCap.compare.selector.kind === 'arg') {
      expect(argCap.compare.selector.argIndex).toBe(0)
      expect(argCap.compare.selector.scalarType).toBe('i128')
      expect(argCap.compare.operator).toBe('lte')
      expect(argCap.compare.value).toBe('50000000')
    }
  })

  it('does NOT bind the cap when no limitAmount is supplied', () => {
    const r = composeFromRecording(soroswapFactsNoSpend(), SOROSWAP_ROUTER, soroswapTopLevel(), {
      network: 'mainnet',
      userResponses: {},
    })
    const argCap = r.interpreterIr.rules[0]?.constraints.find(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'arg'
    )
    expect(argCap).toBeUndefined()
  })

  it('does NOT double-bind: an outgoing spend and a swap input cap bind call_arg[0] once', () => {
    // soroswapFacts() has spendByToken[XLM] set (source == holder), so the
    // spend pass binds the limit. The swap pass must then skip its own input
    // cap - otherwise one limit would be emitted as two identical leaves.
    const r = composeFromRecording(soroswapFacts(), SOROSWAP_ROUTER, soroswapTopLevel(), {
      network: 'mainnet',
      userResponses: { limitAmount: '50000000' },
    })
    const argCaps = (r.interpreterIr.rules[0]?.constraints ?? []).filter(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'arg'
    )
    expect(argCaps.length).toBe(1)
    const argCap = argCaps[0]
    if (argCap?.op === 'compare' && argCap.compare.selector.kind === 'arg') {
      expect(argCap.compare.selector.argIndex).toBe(0)
      expect(argCap.compare.value).toBe('50000000')
    }
  })

  it('swap_tokens_for_exact_tokens: caps arg[1] (amount_in_max), NOT arg[0] (amount_out)', () => {
    // Regression: arg[0] here is the exact OUTPUT; binding the input cap to
    // arg[0] would leave the actual input (amount_in_max = arg[1]) unbounded.
    const r = composeFromRecording(
      soroswapFactsNoSpend(),
      SOROSWAP_ROUTER,
      swapTokensForExactTopLevel(),
      { network: 'mainnet', userResponses: { limitAmount: '50000000' } }
    )
    const argCap = r.interpreterIr.rules[0]?.constraints.find(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'arg'
    )
    expect(argCap).toBeDefined()
    if (argCap && argCap.op === 'compare' && argCap.compare.selector.kind === 'arg') {
      expect(argCap.compare.selector.argIndex).toBe(1)
      expect(argCap.compare.operator).toBe('lte')
      expect(argCap.compare.value).toBe('50000000')
    }
  })

  it('swap_exact_in_for_tokens: caps arg[0] (amount_in)', () => {
    const r = composeFromRecording(soroswapFactsNoSpend(), SOROSWAP_ROUTER, swapExactInTopLevel(), {
      network: 'mainnet',
      userResponses: { limitAmount: '50000000' },
    })
    const argCap = r.interpreterIr.rules[0]?.constraints.find(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'arg'
    )
    expect(argCap).toBeDefined()
    if (argCap && argCap.op === 'compare' && argCap.compare.selector.kind === 'arg') {
      expect(argCap.compare.selector.argIndex).toBe(0)
    }
  })

  it('does NOT surface FREQUENCY_BOUND_MISSING for a fee-sponsored swap (it is not incoming-only)', () => {
    const r = composeFromRecording(soroswapFactsNoSpend(), SOROSWAP_ROUTER, soroswapTopLevel(), {
      network: 'mainnet',
      userResponses: { limitAmount: '50000000' },
    })
    expect(r.ambiguities.some((a) => a.code === 'FREQUENCY_BOUND_MISSING')).toBe(false)
    expect(r.warnings.some((w) => w.includes('incoming-only'))).toBe(false)
  })
})

describe('composeFromRecording - unknown protocol emits no constraint (I4)', () => {
  it('keeps the scope but emits no amount cap; flags the spend descriptively', () => {
    const facts: IntentFacts = {
      callTargets: ['CUNKNOWNCONTRACTADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
      functionsByContract: {},
      spendByToken: { [SEP41_TOKEN]: '1000000000' },
      signers: [G_OWNER],
    }
    const r = composeFromRecording(
      facts,
      'CUNKNOWNCONTRACTADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      unknownTopLevel(),
      { network: 'mainnet', userResponses: { limitAmount: '1000000000' } }
    )
    const rule = r.interpreterIr.rules[0]
    expect(rule).toBeDefined()
    if (!rule) return
    // Scope is still carried (contract + method).
    expect(rule.scope.contract).toBe('CUNKNOWNCONTRACTADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    expect(rule.scope.method).toBe('do_something')
    // No amount cap inferred from an unrecognised call: the ABI is unknown, so
    // there is no argument the limit could be bound to.
    const hasAmountCap = rule.constraints.some(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'arg'
    )
    expect(hasAmountCap).toBe(false)
    expect(rule.constraints.length).toBe(0)
    expect(r.warnings.some((w) => w.includes('unrecognised protocol'))).toBe(true)
  })
})

describe('composeFromRecording - SoroSwap recipient pin-by-default (F1)', () => {
  it('pins call_arg[3] to the recorded recipient when no allowlist is supplied', () => {
    // Mirrors SEP-41 arg[1]: the recorded flow went to exactly one recipient,
    // so the minimal policy that permits exactly that flow pins call_arg[3].
    const r = composeFromRecording(soroswapFactsNoSpend(), SOROSWAP_ROUTER, soroswapTopLevel(), {
      network: 'mainnet',
      userResponses: {},
    })
    const recipient = r.interpreterIr.rules[0]?.constraints.find(
      (c) => c.op === 'in' && c.selector.kind === 'arg' && c.selector.argIndex === 3
    )
    expect(recipient).toBeDefined()
    if (recipient && recipient.op === 'in') {
      expect(recipient.values).toEqual([G_OWNER])
    }
  })

  it('still surfaces RECIPIENT_ALLOWLIST_EMPTY as informational (pinned, not a free pass)', () => {
    const r = composeFromRecording(soroswapFactsNoSpend(), SOROSWAP_ROUTER, soroswapTopLevel(), {
      network: 'mainnet',
      userResponses: {},
    })
    const ambiguity = r.ambiguities.find((a) => a.code === 'RECIPIENT_ALLOWLIST_EMPTY')
    expect(ambiguity).toBeDefined()
    // The wording must say the recipient was PINNED, never that it is left
    // unconstrained.
    expect(ambiguity?.question).toContain(G_OWNER)
    expect(ambiguity?.question.toLowerCase()).toContain('pinned')
    expect(ambiguity?.question.toLowerCase()).not.toContain('unconstrained')
  })

  it('an explicit swapRecipientAllowlist REPLACES the default pin', () => {
    const OTHER = 'GBFKRGJYZXLTDEI36ZCQEIM225NMOCR2VDBOIHJTXJ54FEFFVL2FKALE'
    const r = composeFromRecording(soroswapFactsNoSpend(), SOROSWAP_ROUTER, soroswapTopLevel(), {
      network: 'mainnet',
      userResponses: { swapRecipientAllowlist: [G_OWNER, OTHER] },
    })
    const recipient = r.interpreterIr.rules[0]?.constraints.find(
      (c) => c.op === 'in' && c.selector.kind === 'arg' && c.selector.argIndex === 3
    )
    expect(recipient).toBeDefined()
    if (recipient && recipient.op === 'in') {
      expect(recipient.values).toEqual([G_OWNER, OTHER])
    }
    // No RECIPIENT_ALLOWLIST_EMPTY when the caller supplied an allowlist.
    expect(r.ambiguities.some((a) => a.code === 'RECIPIENT_ALLOWLIST_EMPTY')).toBe(false)
  })
})

describe('composeFromRecording - Blend submit: an unbindable request element is never silent', () => {
  function blendSubmitFacts(): IntentFacts {
    return {
      callTargets: [BLEND_POOL],
      functionsByContract: { [BLEND_POOL]: ['submit'] },
      spendByToken: {},
      signers: [G_OWNER],
    }
  }

  /** requests[0] is a complete Request; requests[1] is whatever the caller passes. */
  function blendSubmitTopLevel(second: ContractInvocation['args'][number]): ContractInvocation {
    return {
      contract: BLEND_POOL,
      fn: 'submit',
      args: [
        { type: 'address', value: G_OWNER },
        { type: 'address', value: G_OWNER },
        { type: 'address', value: G_OWNER },
        {
          type: 'vec',
          value: [
            {
              type: 'map',
              value: [
                { key: 'address', val: { type: 'address', value: USDC_TOKEN } },
                { key: 'amount', val: { type: 'i128', value: '1000000000' } },
                { key: 'request_type', val: { type: 'u32', value: '3' } },
              ],
            },
            second,
          ],
        },
      ],
      subInvocations: [],
    }
  }

  function pinnedElements(r: ReturnType<typeof composeFromRecording>): number[] {
    return (r.interpreterIr.rules[0]?.constraints ?? []).flatMap((c) =>
      c.op === 'compare' &&
      c.compare.selector.kind === 'arg_field' &&
      c.compare.selector.element !== undefined
        ? [c.compare.selector.element]
        : []
    )
  }

  it('pins every element when all of them bind', () => {
    const r = composeFromRecording(
      blendSubmitFacts(),
      BLEND_POOL,
      blendSubmitTopLevel({
        type: 'map',
        value: [
          { key: 'address', val: { type: 'address', value: XLM_TOKEN } },
          { key: 'amount', val: { type: 'i128', value: '5' } },
          { key: 'request_type', val: { type: 'u32', value: '4' } },
        ],
      }),
      { network: 'mainnet', userResponses: {} }
    )
    expect(new Set(pinnedElements(r))).toEqual(new Set([0, 1]))
    expect(r.warnings.some((w) => w.includes('requests'))).toBe(false)
  })

  it('warns when a request element is not a map (arg_len alone leaves it unbound)', () => {
    const r = composeFromRecording(
      blendSubmitFacts(),
      BLEND_POOL,
      blendSubmitTopLevel({ type: 'u32', value: '7' }),
      { network: 'mainnet', userResponses: {} }
    )
    // element[1] contributes no constraint...
    expect(pinnedElements(r)).not.toContain(1)
    // ...so the caller MUST be told the request is unbound.
    expect(r.warnings.some((w) => w.includes('element 1'))).toBe(true)
  })

  it('warns when a request element is missing a bindable field', () => {
    const r = composeFromRecording(
      blendSubmitFacts(),
      BLEND_POOL,
      blendSubmitTopLevel({
        type: 'map',
        value: [
          { key: 'address', val: { type: 'address', value: XLM_TOKEN } },
          { key: 'request_type', val: { type: 'u32', value: '4' } },
        ],
      }),
      { network: 'mainnet', userResponses: {} }
    )
    expect(pinnedElements(r)).not.toContain(1)
    expect(r.warnings.some((w) => w.includes('element 1'))).toBe(true)
  })
})

describe('composeFromRecording - determinism', () => {
  it('same inputs -> identical IR + ambiguities + warnings across runs', () => {
    const opts = {
      network: 'mainnet' as const,
      userResponses: { limitAmount: '1000000000' },
    }
    const a = composeFromRecording(sep41Facts(), SEP41_TOKEN, sep41TopLevel(), opts)
    const b = composeFromRecording(sep41Facts(), SEP41_TOKEN, sep41TopLevel(), opts)
    expect(a.interpreterIr).toEqual(b.interpreterIr)
    expect(a.ambiguities).toEqual(b.ambiguities)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
