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
      userResponses: { windowSeconds: 2592000, limitAmount: '1000000000' },
    })
    expect(sep41.ir.rules[0]?.scope).toEqual({ contract: SEP41_TOKEN, method: 'transfer' })

    const blend = composeFromRecording(blendFacts(), BLEND_POOL, blendTopLevel(), {
      network: 'mainnet',
    })
    expect(blend.ir.rules[0]?.scope.method).toBe('claim')

    const soroswap = composeFromRecording(soroswapFacts(), SOROSWAP_ROUTER, soroswapTopLevel(), {
      network: 'mainnet',
    })
    expect(soroswap.ir.rules[0]?.scope.method).toBe('swap_exact_tokens_for_tokens')
  })
})

describe('composeFromRecording - SEP-41 subscription (limit + window supplied)', () => {
  it('emits window_spent <= caller limit (OZ-shape) + recipient allowlist (interpreter-shape)', () => {
    const r = composeFromRecording(sep41Facts(), SEP41_TOKEN, sep41TopLevel(), {
      network: 'mainnet',
      interpreterEnabled: true,
      userResponses: { windowSeconds: 2592000, limitAmount: '1000000000' },
    })
    expect(r.ambiguities).toEqual([])
    const rule = r.ir.rules[0]
    expect(rule).toBeDefined()
    if (!rule) return
    expect(rule.scope).toEqual({ contract: SEP41_TOKEN, method: 'transfer' })
    // Spending_limit goes to OZ (token === scope.contract -> OZ lowers it).
    expect(rule.constraints.length).toBe(1)
    const spend = rule.constraints[0]
    expect(spend?.op).toBe('compare')
    if (spend?.op === 'compare') {
      expect(spend.compare.selector.kind).toBe('window_spent')
      if (spend.compare.selector.kind === 'window_spent') {
        expect(spend.compare.selector.token).toBe(SEP41_TOKEN)
        expect(spend.compare.selector.windowSeconds).toBe(2592000)
      }
      expect(spend.compare.operator).toBe('lte')
      expect(spend.compare.value).toBe('1000000000')
    }
    // Recipient allowlist goes to the interpreter-shape IR.
    const interpRule = r.interpreterIr.rules[0]
    expect(interpRule).toBeDefined()
    if (!interpRule) return
    expect(interpRule.constraints.length).toBe(1)
    const recipient = interpRule.constraints[0]
    expect(recipient?.op).toBe('in')
  })

  it('uses validUntilLedger from userResponses as rule.expiry', () => {
    const r = composeFromRecording(sep41Facts(), SEP41_TOKEN, sep41TopLevel(), {
      network: 'mainnet',
      userResponses: {
        windowSeconds: 2592000,
        limitAmount: '1000000000',
        validUntilLedger: 1000000,
      },
    })
    expect(r.ir.rules[0]?.expiry).toEqual({ validUntilLedger: 1000000 })
  })
})

describe('composeFromRecording - amount is an ambiguity, never an auto-ceiling (I1)', () => {
  it('surfaces AMOUNT_BOUND_MISSING with the observed amount and emits no spending_limit when limit absent', () => {
    const r = composeFromRecording(sep41Facts(), SEP41_TOKEN, sep41TopLevel(), {
      network: 'mainnet',
      userResponses: { windowSeconds: 2592000 },
    })
    const amount = r.ambiguities.find((a) => a.code === 'AMOUNT_BOUND_MISSING')
    expect(amount).toBeDefined()
    expect(amount?.question).toContain('1000000000')
    const rule = r.ir.rules[0]
    expect(rule).toBeDefined()
    if (!rule) return
    const hasSpending = rule.constraints.some(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'window_spent'
    )
    expect(hasSpending).toBe(false)
  })

  it('surfaces DURATION_UNSPECIFIED and emits no spending_limit when window absent', () => {
    const r = composeFromRecording(sep41Facts(), SEP41_TOKEN, sep41TopLevel(), {
      network: 'mainnet',
      userResponses: { limitAmount: '1000000000' },
    })
    expect(r.ambiguities.some((a) => a.code === 'DURATION_UNSPECIFIED')).toBe(true)
    const rule = r.ir.rules[0]
    expect(rule).toBeDefined()
    if (!rule) return
    const hasSpending = rule.constraints.some(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'window_spent'
    )
    expect(hasSpending).toBe(false)
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
      userResponses: { windowSeconds: 86400, limitAmount: '50000000' },
    })
    const amountBounds = r.ambiguities.filter((a) => a.code === 'AMOUNT_BOUND_MISSING')
    // A single caller limit cannot disambiguate two tokens -> one prompt per token.
    expect(amountBounds.length).toBe(2)
    expect(amountBounds.some((a) => a.question.includes(XLM_TOKEN))).toBe(true)
    expect(amountBounds.some((a) => a.question.includes(USDC_TOKEN))).toBe(true)
    // No spending_limit compiled from an ambiguous multi-token spend.
    const spends = r.ir.rules[0]?.constraints.filter(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'window_spent'
    )
    expect(spends?.length).toBe(0)
  })

  it('two-token outgoing flow with only an invocationLimit (no limitAmount) still emits no bound', () => {
    // invocation_count is an incoming-only bound; on an outgoing spend it must be
    // ignored, and a multi-token spend cannot bind a single caller limit anyway.
    // The flow must fail closed: no window_spent, no invocation_count, one
    // AMOUNT_BOUND_MISSING per token.
    const facts: IntentFacts = {
      callTargets: [SOROSWAP_ROUTER],
      functionsByContract: { [SOROSWAP_ROUTER]: ['swap_exact_tokens_for_tokens'] },
      spendByToken: { [XLM_TOKEN]: '50000000', [USDC_TOKEN]: '45000000' },
      signers: [G_OWNER],
    }
    const r = composeFromRecording(facts, SOROSWAP_ROUTER, soroswapTopLevel(), {
      network: 'mainnet',
      userResponses: { windowSeconds: 86400, invocationLimit: 3 },
    })
    const rule = r.ir.rules[0]
    expect(rule).toBeDefined()
    if (!rule) return
    const hasSpend = rule.constraints.some(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'window_spent'
    )
    expect(hasSpend).toBe(false)
    const hasInvocationCount = rule.constraints.some(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'invocation_count'
    )
    expect(hasInvocationCount).toBe(false)
    const amountBounds = r.ambiguities.filter((a) => a.code === 'AMOUNT_BOUND_MISSING')
    expect(amountBounds.length).toBe(2)
  })
})

describe('composeFromRecording - Blend yield-claim (incoming only, I2)', () => {
  it('does NOT emit an invocation_count and surfaces FREQUENCY_BOUND_MISSING when no bound supplied', () => {
    const r = composeFromRecording(blendFacts(), BLEND_POOL, blendTopLevel(), {
      network: 'mainnet',
      userResponses: { windowSeconds: 86400 },
    })
    const rule = r.ir.rules[0]
    expect(rule).toBeDefined()
    if (!rule) return
    const hasInvocation = rule.constraints.some(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'invocation_count'
    )
    expect(hasInvocation).toBe(false)
    expect(r.ambiguities.some((a) => a.code === 'FREQUENCY_BOUND_MISSING')).toBe(true)
    expect(r.warnings.some((w) => w.includes('frequency bound'))).toBe(true)
  })

  it('emits an invocation_count bound only when the caller supplies count + window', () => {
    const r = composeFromRecording(blendFacts(), BLEND_POOL, blendTopLevel(), {
      network: 'mainnet',
      interpreterEnabled: true,
      userResponses: { windowSeconds: 86400, invocationLimit: 3 },
    })
    // invocation_count goes to the interpreter-shape IR (OZ cannot lower it).
    const ic = r.interpreterIr.rules[0]?.constraints.find(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'invocation_count'
    )
    expect(ic).toBeDefined()
    if (ic && ic.op === 'compare' && ic.compare.selector.kind === 'invocation_count') {
      expect(ic.compare.selector.windowSeconds).toBe(86400)
      expect(ic.compare.value).toBe('3')
    }
    // And it is NOT in the OZ-shape IR.
    const ozHasInvocation = (r.ir.rules[0]?.constraints ?? []).some(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'invocation_count'
    )
    expect(ozHasInvocation).toBe(false)
  })
})

describe('composeFromRecording - SoroSwap swap: no fabricated constraints (I2)', () => {
  it('emits spending_limit on the input token (interpreter-shape) but no oracle_price and no synthetic path compare', () => {
    const r = composeFromRecording(soroswapFacts(), SOROSWAP_ROUTER, soroswapTopLevel(), {
      network: 'mainnet',
      interpreterEnabled: true,
      userResponses: { windowSeconds: 86400, limitAmount: '50000000' },
    })
    const ozRule = r.ir.rules[0]
    expect(ozRule).toBeDefined()
    if (!ozRule) return
    const interpRule = r.interpreterIr.rules[0]
    expect(interpRule).toBeDefined()
    if (!interpRule) return
    // 1. window_spent on XLM goes to the OZ-shape IR even though the token is
    //    not the scope contract. OZ owns rolling spend caps and reports the
    //    ones it cannot lower; the interpreter is NOT a fallback, because it
    //    cannot observe token movements and the counter would never bind.
    const spendOz = ozRule.constraints.find(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'window_spent'
    )
    expect(spendOz).toBeDefined()
    const spendInterp = interpRule.constraints.find(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'window_spent'
    )
    expect(spendInterp).toBeUndefined()
    // 2. NO fabricated oracle_price node in EITHER IR.
    const oracleOz = ozRule.constraints.find(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'oracle_price'
    )
    const oracleInterp = interpRule.constraints.find(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'oracle_price'
    )
    expect(oracleOz).toBeUndefined()
    expect(oracleInterp).toBeUndefined()
    // 3. NO synthetic per-arg path compare node (oraclePriceBound absent).
    const argCompare = interpRule.constraints.find(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'arg'
    )
    expect(argCompare).toBeUndefined()
    // 4. The exact hop path is recorded as an eq_seq node on call_arg[2].
    const eqSeq = interpRule.constraints.find((c) => c.op === 'eq_seq')
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
  it('binds limitAmount to call_arg[0] as an lte compare in the interpreter-shape IR', () => {
    const r = composeFromRecording(soroswapFactsNoSpend(), SOROSWAP_ROUTER, soroswapTopLevel(), {
      network: 'mainnet',
      interpreterEnabled: true,
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
    // The OZ-shape IR carries no per-arg compare (OZ built-ins can't express it).
    const ozArg = r.ir.rules[0]?.constraints.find(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'arg'
    )
    expect(ozArg).toBeUndefined()
  })

  it('routes the cap to the OZ IR (flagged uncovered) when the interpreter is not enabled', () => {
    const r = composeFromRecording(soroswapFactsNoSpend(), SOROSWAP_ROUTER, soroswapTopLevel(), {
      network: 'mainnet',
      userResponses: { limitAmount: '50000000' },
    })
    const ozArg = r.ir.rules[0]?.constraints.find(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'arg'
    )
    expect(ozArg).toBeDefined()
    expect(r.interpreterIr.rules[0]?.constraints.length).toBe(0)
  })

  it('does NOT bind the cap when no limitAmount is supplied', () => {
    const r = composeFromRecording(soroswapFactsNoSpend(), SOROSWAP_ROUTER, soroswapTopLevel(), {
      network: 'mainnet',
      interpreterEnabled: true,
      userResponses: {},
    })
    const argCap = r.interpreterIr.rules[0]?.constraints.find(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'arg'
    )
    expect(argCap).toBeUndefined()
  })

  it('does NOT double-bind: when an outgoing spend IS detected the limit binds window_spent, not call_arg[0]', () => {
    // soroswapFacts() has spendByToken[XLM] set (source == holder). The limit
    // binds the window_spent path; the per-call arg cap is skipped.
    const r = composeFromRecording(soroswapFacts(), SOROSWAP_ROUTER, soroswapTopLevel(), {
      network: 'mainnet',
      interpreterEnabled: true,
      userResponses: { windowSeconds: 86400, limitAmount: '50000000' },
    })
    const argCap = r.interpreterIr.rules[0]?.constraints.find(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'arg'
    )
    expect(argCap).toBeUndefined()
    // The spend binds once, on the OZ side - rolling caps are OZ's primitive.
    const spend = r.ir.rules[0]?.constraints.find(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'window_spent'
    )
    expect(spend).toBeDefined()
  })

  it('swap_tokens_for_exact_tokens: caps arg[1] (amount_in_max), NOT arg[0] (amount_out)', () => {
    // Regression: arg[0] here is the exact OUTPUT; binding the input cap to
    // arg[0] would leave the actual input (amount_in_max = arg[1]) unbounded.
    const r = composeFromRecording(
      soroswapFactsNoSpend(),
      SOROSWAP_ROUTER,
      swapTokensForExactTopLevel(),
      { network: 'mainnet', interpreterEnabled: true, userResponses: { limitAmount: '50000000' } }
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
      interpreterEnabled: true,
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
      interpreterEnabled: true,
      userResponses: { limitAmount: '50000000' },
    })
    expect(r.ambiguities.some((a) => a.code === 'FREQUENCY_BOUND_MISSING')).toBe(false)
    expect(r.warnings.some((w) => w.includes('incoming-only'))).toBe(false)
  })
})

describe('composeFromRecording - unknown protocol never emits an OZ primitive (I4)', () => {
  it('keeps the scope but emits no window_spent; flags the spend Path-B', () => {
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
      { network: 'mainnet', userResponses: { windowSeconds: 2592000, limitAmount: '1000000000' } }
    )
    const rule = r.ir.rules[0]
    expect(rule).toBeDefined()
    if (!rule) return
    // Scope is still carried (contract + method).
    expect(rule.scope.contract).toBe('CUNKNOWNCONTRACTADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    expect(rule.scope.method).toBe('do_something')
    // No spending_limit-producing node inferred from an unrecognised call.
    const hasSpending = rule.constraints.some(
      (c) => c.op === 'compare' && c.compare.selector.kind === 'window_spent'
    )
    expect(hasSpending).toBe(false)
    expect(rule.constraints.length).toBe(0)
    expect(r.warnings.some((w) => w.includes('unrecognised protocol'))).toBe(true)
  })
})

describe('composeFromRecording - SoroSwap recipient pin-by-default (F1)', () => {
  it('pins call_arg[3] to the recorded recipient when interpreter enabled and no allowlist supplied', () => {
    // Mirrors SEP-41 arg[1]: the recorded flow went to exactly one recipient,
    // so the minimal policy that permits exactly that flow pins call_arg[3].
    const r = composeFromRecording(soroswapFactsNoSpend(), SOROSWAP_ROUTER, soroswapTopLevel(), {
      network: 'mainnet',
      interpreterEnabled: true,
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
      interpreterEnabled: true,
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
      interpreterEnabled: true,
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

  it('does NOT pin the recipient when interpreter is disabled (today behaviour)', () => {
    const r = composeFromRecording(soroswapFactsNoSpend(), SOROSWAP_ROUTER, soroswapTopLevel(), {
      network: 'mainnet',
      userResponses: {},
    })
    const recipient = r.interpreterIr.rules[0]?.constraints.find(
      (c) => c.op === 'in' && c.selector.kind === 'arg' && c.selector.argIndex === 3
    )
    expect(recipient).toBeUndefined()
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
      { network: 'mainnet', interpreterEnabled: true, userResponses: {} }
    )
    expect(new Set(pinnedElements(r))).toEqual(new Set([0, 1]))
    expect(r.warnings.some((w) => w.includes('requests'))).toBe(false)
  })

  it('warns when a request element is not a map (arg_len alone leaves it unbound)', () => {
    const r = composeFromRecording(
      blendSubmitFacts(),
      BLEND_POOL,
      blendSubmitTopLevel({ type: 'u32', value: '7' }),
      { network: 'mainnet', interpreterEnabled: true, userResponses: {} }
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
      { network: 'mainnet', interpreterEnabled: true, userResponses: {} }
    )
    expect(pinnedElements(r)).not.toContain(1)
    expect(r.warnings.some((w) => w.includes('element 1'))).toBe(true)
  })
})

describe('composeFromRecording - determinism', () => {
  it('same inputs -> identical IR + ambiguities + warnings across runs', () => {
    const opts = {
      network: 'mainnet' as const,
      userResponses: { windowSeconds: 2592000, limitAmount: '1000000000' },
    }
    const a = composeFromRecording(sep41Facts(), SEP41_TOKEN, sep41TopLevel(), opts)
    const b = composeFromRecording(sep41Facts(), SEP41_TOKEN, sep41TopLevel(), opts)
    expect(a.ir).toEqual(b.ir)
    expect(a.ambiguities).toEqual(b.ambiguities)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('composeFromRecording - swap slippage floor', () => {
  const opts = { network: 'mainnet' as const, interpreter: { enabled: true } }

  it('emits no floor when the caller supplies no ratio', () => {
    // The recorded in/out pair is a price at one moment. Deriving a floor from
    // it would freeze that rate as policy and deny ordinary trades as soon as
    // the market moved, so absence must stay absence.
    const r = composeFromRecording(soroswapFacts(), SOROSWAP_ROUTER, soroswapTopLevel(), opts)
    expect(JSON.stringify(r.ir)).not.toContain('slippage_floor')
  })

  it('emits the floor when the caller supplies the ratio', () => {
    const r = composeFromRecording(soroswapFacts(), SOROSWAP_ROUTER, soroswapTopLevel(), {
      ...opts,
      userResponses: { swapMinOutRatio: { num: '95', den: '100' } },
    })
    const floors = JSON.stringify(r.ir)
    expect(floors).toContain('slippage_floor')
    // Bounds the OUTPUT arg against the INPUT arg of the same call:
    // swap_exact_tokens_for_tokens is [amount_in, amount_out_min, ...].
    expect(floors).toContain('"outArgIndex":1')
    expect(floors).toContain('"inArgIndex":0')
    expect(floors).toContain('"num":"95"')
  })
})
