// Tests for the install / revoke / get_interpreter_info run-layer glue.
//
// Coverage:
//   1. Schemas reject malformed input (no smartAccount, no rule, etc.).
//   2. Each run fn returns a structured ToolError on bad input (the
//      envelope converts Zod failures + SDK throws into machine-readable
//      codes an agent can dispatch on).
//   3. For install, the returned XDR is real - it round-trips through
//      `Sdk.TransactionBuilder.fromXDR` as a Soroban Transaction. This
//      closes the "non-empty string" gap: a builder that produced
//      arbitrary base64 would pass a length check but fail the decode.
//   4. The literal_bytes / literal_u32 schema fixes
//      hold (regression coverage for the bug-fixes wired in this PR).
//
// The RPC client is mocked: install/revoke need getAccount +
// simulateTransaction + getLatestLedger. The mock returns canned
// responses; the schema + envelope code is what we are really testing
// here. The end-to-end live-RPC coverage lives in scripts/.

import { describe, expect, it } from 'bun:test'
import {
  Account,
  Address,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  Operation,
  type rpc,
  SorobanDataBuilder,
  scValToNative,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import { PLACEHOLDER_INTERPRETER_ADDRESS } from '../adapters/interpreter/adapter.ts'
import type { InstallRpcClient } from '../install/build-install-policy.ts'
import { encodePredicate } from '../predicate/encode.ts'
import { runGetInterpreterInfo, runInstallPolicy, runRevokePolicy } from './index.ts'
import {
  GetInterpreterInfoInputSchema,
  InstallPolicyInputSchema,
  MAINNET_RPC_URL,
  PINNED_INTERPRETER_GRAMMAR_VERSION,
  PINNED_INTERPRETER_MAINNET_ADDRESS,
  PINNED_INTERPRETER_TESTNET_ADDRESS,
  PINNED_INTERPRETER_WASM_SHA256,
  RevokePolicyInputSchema,
  TESTNET_RPC_URL,
} from './schemas.ts'

// ---- fixtures ----

const SMART_ACCOUNT = 'CDEG66TYZB2RTKRSIEA4UTFMRXOYESCEQUKWS7R2JN357PJDSY272PFK'
const SOURCE_ACCOUNT = Keypair.random().publicKey()

function makeRule() {
  const pred = encodePredicate({
    op: 'eq',
    left: { kind: 'call_fn' },
    right: { kind: 'literal_symbol', value: 'transfer' },
  })
  return {
    encodedPredicate: pred.encodedPredicate,
    predicateHash: pred.predicateHash,
    rule: {
      contextRuleType: { kind: 'default' as const },
      name: 'test-rule',
      validUntilLedger: null,
      signers: [{ kind: 'delegated' as const, address: SOURCE_ACCOUNT }],
      policies: [
        {
          kind: 'interpreter' as const,
          interpreterAddress: SMART_ACCOUNT,
          predicateBlobBase64: pred.encodedPredicate,
        },
      ],
    },
  }
}

function makeValidInstallInput() {
  return {
    smartAccount: SMART_ACCOUNT,
    sourceAccount: SOURCE_ACCOUNT,
    rule: makeRule().rule,
    installNonce: 1,
  }
}

function makeValidRevokeInput() {
  return {
    smartAccount: SMART_ACCOUNT,
    sourceAccount: SOURCE_ACCOUNT,
    ruleId: 1,
  }
}

function _makeValidGetInfoInput() {
  return { network: 'testnet' as const }
}

/** Build a deterministic mock RPC client. Records the inputs the run-layer
 *  passes; returns canned responses so the install/revoke path runs to
 *  completion without a network. */
function mockRpcClient(
  opts: {
    /** When set, simulateTransaction returns an error. */
    simError?: string
    /** Limit simError to this 1-based simulation call. */
    simErrorOnCall?: number
  } = {}
): InstallRpcClient & {
  getAccountCalls: string[]
  simulateCalls: Transaction[]
  getLatestLedgerCalls: number
} {
  const state = {
    getAccountCalls: [] as string[],
    simulateCalls: [] as Transaction[],
    getLatestLedgerCalls: 0,
  }
  const _txEnvelopeBase = () => {
    const account = new Account(SOURCE_ACCOUNT, '100')
    return new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: 'Test SDF Network ; September 2015',
    })
      .addOperation(
        Operation.invokeHostFunction({
          func: xdr.HostFunction.hostFunctionTypeInvokeContract(
            new xdr.InvokeContractArgs({
              contractAddress: new Address(SMART_ACCOUNT).toScAddress(),
              functionName: 'add_context_rule',
              args: [nativeToScVal(1, { type: 'u32' })],
            })
          ),
          auth: [],
        })
      )
      .setTimeout(0)
      .build()
  }
  return {
    state,
    getAccountCalls: state.getAccountCalls,
    simulateCalls: state.simulateCalls,
    getLatestLedgerCalls: 0,
    async getAccount(address) {
      state.getAccountCalls.push(address)
      return { sequenceNumber: () => '100' }
    },
    async simulateTransaction(tx) {
      const transaction = tx as Transaction
      state.simulateCalls.push(transaction)
      if (
        opts.simError &&
        (opts.simErrorOnCall === undefined || opts.simErrorOnCall === state.simulateCalls.length)
      ) {
        // Return a simulation-error response the run-layer will convert
        // into INSTALL_BUILD_FAILED.
        return {
          error: opts.simError,
        } as unknown as Awaited<ReturnType<rpc.Server['simulateTransaction']>>
      }
      // Build the recorded smart-account auth entry from the operation being
      // simulated, preserving its exact function and arguments.
      const invocationOp = transaction.operations[0]
      if (invocationOp?.type !== 'invokeHostFunction') {
        throw new Error('mock expected an invokeHostFunction operation')
      }
      const invokeContractArgs = invocationOp.func.invokeContract()
      const creds = new xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(SMART_ACCOUNT).toScAddress(),
          nonce: new xdr.Int64(1n),
          signatureExpirationLedger: 200,
          signature: xdr.ScVal.scvVoid(),
        })
      )
      const authEntry = new xdr.SorobanAuthorizationEntry({
        credentials: creds,
        rootInvocation: new xdr.SorobanAuthorizedInvocation({
          function:
            xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
              invokeContractArgs
            ),
          subInvocations: [],
        }),
      })
      return {
        _parsed: true,
        id: 'mock-simulation',
        latestLedger: 100,
        events: [],
        transactionData: new SorobanDataBuilder(),
        minResourceFee: '123',
        result: { auth: [authEntry], retval: xdr.ScVal.scvVoid() },
      } as unknown as Awaited<ReturnType<rpc.Server['simulateTransaction']>>
    },
    async getLatestLedger() {
      state.getLatestLedgerCalls += 1
      return { sequence: 100 }
    },
    async getContractVersion(address: string) {
      // Default to "matches the pin" for happy-path tests.
      void address
      return 1
    },
  }
}

// ---- schema rejection ----

describe('InstallPolicyInputSchema rejects malformed input', () => {
  it('rejects an empty object', () => {
    expect(InstallPolicyInputSchema.safeParse({}).success).toBe(false)
  })

  it('rejects a rule with no signers and no policies (install-gate guard)', () => {
    const input = makeValidInstallInput()
    input.rule = {
      contextRuleType: { kind: 'default' },
      name: 'empty-rule',
      validUntilLedger: null,
      signers: [],
      policies: [],
    }
    const res = InstallPolicyInputSchema.safeParse(input)
    expect(res.success).toBe(false)
  })

  it('rejects a non-positive installNonce', () => {
    const input = { ...makeValidInstallInput(), installNonce: 0 }
    expect(InstallPolicyInputSchema.safeParse(input).success).toBe(false)
  })

  it('accepts a fully-populated input', () => {
    expect(InstallPolicyInputSchema.safeParse(makeValidInstallInput()).success).toBe(true)
  })
})

describe('RevokePolicyInputSchema rejects malformed input', () => {
  it('rejects a negative ruleId', () => {
    const input = { ...makeValidRevokeInput(), ruleId: -1 }
    expect(RevokePolicyInputSchema.safeParse(input).success).toBe(false)
  })

  it('rejects an empty object', () => {
    expect(RevokePolicyInputSchema.safeParse({}).success).toBe(false)
  })

  it('accepts a fully-populated input', () => {
    expect(RevokePolicyInputSchema.safeParse(makeValidRevokeInput()).success).toBe(true)
  })
})

describe('GetInterpreterInfoInputSchema rejects malformed input', () => {
  it('accepts an empty object (network defaults to testnet)', () => {
    expect(GetInterpreterInfoInputSchema.safeParse({}).success).toBe(true)
  })

  it('rejects an invalid network', () => {
    expect(GetInterpreterInfoInputSchema.safeParse({ network: 'not-a-network' }).success).toBe(
      false
    )
  })
})

// ---- run-layer envelope ----

describe('runInstallPolicy envelope', () => {
  it('returns INSTALL_BUILD_FAILED on a Zod-invalid input', async () => {
    const res = await runInstallPolicy({})
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('INSTALL_BUILD_FAILED')
    expect(res.error.message).toContain('install_policy')
    expect(res.error.remediation?.toolCall?.name).toBe('install_policy')
  })

  it('returns INSTALL_BUILD_FAILED when the RPC simulation errors', async () => {
    // Inject a mock that fails simulation. We can't easily inject the
    // mock client through the public API (the run-layer constructs it
    // internally); exercise the envelope by passing a bad rpcUrl (the
    // server-side construction will throw inside the try/catch).
    const input = {
      ...makeValidInstallInput(),
      // Use a clearly-bad URL that will reject at construction time.
      rpcUrl: 'http://127.0.0.1:1/should-not-connect',
    }
    const res = await runInstallPolicy(input)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('INSTALL_BUILD_FAILED')
  })
})

describe('runRevokePolicy envelope', () => {
  it('returns REVOKE_BUILD_FAILED on a Zod-invalid input', async () => {
    const res = await runRevokePolicy({})
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('REVOKE_BUILD_FAILED')
    expect(res.error.message).toContain('revoke_policy')
    expect(res.error.remediation?.toolCall?.name).toBe('revoke_policy')
  })
})

describe('runGetInterpreterInfo envelope', () => {
  it('returns the pinned fingerprint without verification', async () => {
    const res = await runGetInterpreterInfo({ network: 'testnet' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // Asserted against the constants, not frozen literals: this pins that the
    // run layer SURFACES the pin unchanged. Whether the pin itself is right is
    // grammar-version-parity.test.ts's job, so a redeploy does not break this.
    expect(res.data.pinnedAddress).toBe(PINNED_INTERPRETER_TESTNET_ADDRESS)
    expect(res.data.pinnedGrammarVersion).toBe(PINNED_INTERPRETER_GRAMMAR_VERSION)
    expect(res.data.pinnedWasmHash).toBe(PINNED_INTERPRETER_WASM_SHA256)
    expect(res.data.network).toBe('testnet')
    // liveMatchesPin is absent (no verifyLive call).
    expect(res.data.liveMatchesPin).toBeUndefined()
    expect(res.data.deployedGrammarVersion).toBeUndefined()
  })

  it('omits any audit field (no fabricated references)', async () => {
    const res = await runGetInterpreterInfo({ network: 'testnet' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const keys = Object.keys(res.data)
    // The audit field MUST be absent - fabricating an audit id would be a
    // lie on a security surface.
    expect(keys).not.toContain('auditRef')
    expect(keys).not.toContain('audit_id')
    expect(keys).not.toContain('audit')
  })
})

// ---- XDR round-trip ----
//
// The whole point of the install tool is that the wallet can sign the
// returned XDR. A builder that emits arbitrary base64 garbage would pass
// a "non-empty string" length check and waste a wallet signature attempt.
// This test pins the wire shape: the returned XDR MUST decode as a
// Soroban Transaction.

describe('install_policy XDR round-trip', () => {
  it('returns an XDR that decodes as a Soroban Transaction', async () => {
    // We can't easily inject the mock client into the run-layer (it
    // constructs the RPC client internally), so call the lower-level
    // builder directly with a mock client. The run-layer envelope is
    // tested above; this test pins the WIRE shape.
    const { buildInstallPolicyXdr } = await import('../install/build-install-policy.ts')
    const mock = mockRpcClient()
    const m = makeRule()
    const result = await buildInstallPolicyXdr({
      smartAccount: SMART_ACCOUNT,
      sourceAccount: SOURCE_ACCOUNT,
      networkPassphrase: 'Test SDF Network ; September 2015',
      rule: m.rule,
      installNonce: 1,
      encodedPredicate: m.encodedPredicate,
      predicateHash: m.predicateHash,
      rpc: mock,
    })
    // The unsigned XDR is base64; Sdk.TransactionBuilder.fromXDR returns
    // a Transaction when the bytes are a valid envelope.
    expect(typeof result.unsignedXdr).toBe('string')
    expect(result.unsignedXdr.length).toBeGreaterThan(0)
    const tx = TransactionBuilder.fromXDR(
      result.unsignedXdr,
      'Test SDF Network ; September 2015'
    ) as Transaction
    // The fromXDR type union includes Transaction + FeeBumpTransaction;
    // assert the specific kind we expect.
    expect(tx).toBeInstanceOf(Transaction)
    expect(tx.toEnvelope().toXDR().toString('base64')).toBe(result.unsignedXdr)

    // The consumer gets the enforcing simulation's assembled envelope, not the
    // recording envelope: it already carries OZ auth, resource data, and fees.
    expect(mock.simulateCalls).toHaveLength(2)
    const enforcingInputOp = mock.simulateCalls[1]?.operations[0]
    expect(enforcingInputOp?.type).toBe('invokeHostFunction')
    if (enforcingInputOp?.type !== 'invokeHostFunction') {
      throw new Error('expected enforcing simulation input to invoke a host function')
    }
    expect(enforcingInputOp.auth).toHaveLength(2)

    const finalOp = tx.operations[0]
    expect(finalOp?.type).toBe('invokeHostFunction')
    if (finalOp?.type !== 'invokeHostFunction') {
      throw new Error('expected final install transaction to invoke a host function')
    }
    expect(finalOp.auth).toHaveLength(2)
    const accountAuth = finalOp.auth[0]
    if (!accountAuth) {
      throw new Error('expected final install transaction to include account auth')
    }
    expect(accountAuth.credentials().switch().name).toBe('sorobanCredentialsAddress')
    expect(Address.fromScAddress(accountAuth.credentials().address().address()).toString()).toBe(
      SMART_ACCOUNT
    )
    expect(accountAuth.credentials().address().signatureExpirationLedger()).toBe(400)
    const payload = scValToNative(accountAuth.credentials().address().signature()) as {
      context_rule_ids: number[]
    }
    expect(payload.context_rule_ids).toEqual([0])
    expect(finalOp.auth[1]?.credentials().switch().name).toBe('sorobanCredentialsSourceAccount')
    expect(tx.fee).toBe('223')
    expect(tx.toEnvelope().v1().tx().ext().sorobanData().toXDR().length).toBeGreaterThan(0)

    // The captured auth nonce + rootInvocation must round-trip as well.
    expect(result.authNonce).toBe('1')
    expect(typeof result.rootInvocationXdr).toBe('string')
    expect(result.rootInvocationXdr.length).toBeGreaterThan(0)
  })

  it('fails closed when the auth-enforcing simulation rejects install', async () => {
    const { buildInstallPolicyXdr } = await import('../install/build-install-policy.ts')
    const mock = mockRpcClient({ simError: 'auth rejected', simErrorOnCall: 2 })
    const m = makeRule()

    await expect(
      buildInstallPolicyXdr({
        smartAccount: SMART_ACCOUNT,
        sourceAccount: SOURCE_ACCOUNT,
        networkPassphrase: 'Test SDF Network ; September 2015',
        rule: m.rule,
        installNonce: 1,
        encodedPredicate: m.encodedPredicate,
        predicateHash: m.predicateHash,
        rpc: mock,
      })
    ).rejects.toThrow('install_policy: auth simulateTransaction failed')
    expect(mock.simulateCalls).toHaveLength(2)
  })

  it('installs the predicate in the single add_context_rule call', async () => {
    const { buildInstallPolicyXdr } = await import('../install/build-install-policy.ts')
    const mock = mockRpcClient()
    const m = makeRule()
    const result = await buildInstallPolicyXdr({
      smartAccount: SMART_ACCOUNT,
      sourceAccount: SOURCE_ACCOUNT,
      networkPassphrase: 'Test SDF Network ; September 2015',
      rule: m.rule,
      installNonce: 1,
      encodedPredicate: m.encodedPredicate,
      predicateHash: m.predicateHash,
      rpc: mock,
    })
    expect(result.call.fn).toBe('add_context_rule')
    // No second call is advertised. Issuing interpreter.install after this
    // one fails: the account re-enters the interpreter mid-install.
    expect('followUp' in result).toBe(false)
  })
})

describe('revoke_policy XDR round-trip', () => {
  it('returns an XDR that decodes as a Soroban Transaction', async () => {
    const { buildRevokePolicyXdr } = await import('../install/build-install-policy.ts')
    const mock = mockRpcClient()
    const result = await buildRevokePolicyXdr({
      smartAccount: SMART_ACCOUNT,
      sourceAccount: SOURCE_ACCOUNT,
      ruleId: 3,
      networkPassphrase: 'Test SDF Network ; September 2015',
      rpc: mock,
    })
    expect(typeof result.unsignedXdr).toBe('string')
    expect(result.call.fn).toBe('remove_context_rule')
    expect(result.call.ruleId).toBe(3)
    const tx = TransactionBuilder.fromXDR(
      result.unsignedXdr,
      'Test SDF Network ; September 2015'
    ) as Transaction
    expect(tx).toBeInstanceOf(Transaction)
    expect(mock.simulateCalls).toHaveLength(2)
    const finalOp = tx.operations[0]
    expect(finalOp?.type).toBe('invokeHostFunction')
    if (finalOp?.type !== 'invokeHostFunction') {
      throw new Error('expected final revoke transaction to invoke a host function')
    }
    expect(finalOp.auth).toHaveLength(2)
    const accountAuth = finalOp.auth[0]
    if (!accountAuth) {
      throw new Error('expected final revoke transaction to include account auth')
    }
    const payload = scValToNative(accountAuth.credentials().address().signature()) as {
      context_rule_ids: number[]
    }
    expect(payload.context_rule_ids).toEqual([0])
    const rootInvoke = accountAuth.rootInvocation().function().contractFn()
    expect(rootInvoke.functionName().toString()).toBe('remove_context_rule')
    expect(rootInvoke.args()[0]?.u32()).toBe(3)
    expect(finalOp.auth[1]?.credentials().switch().name).toBe('sorobanCredentialsSourceAccount')
    expect(tx.fee).toBe('223')
    expect(tx.toEnvelope().v1().tx().ext().sorobanData().toXDR().length).toBeGreaterThan(0)
  })

  it('fails closed when the auth-enforcing simulation rejects revoke', async () => {
    const { buildRevokePolicyXdr } = await import('../install/build-install-policy.ts')
    const mock = mockRpcClient({ simError: 'auth rejected', simErrorOnCall: 2 })

    await expect(
      buildRevokePolicyXdr({
        smartAccount: SMART_ACCOUNT,
        sourceAccount: SOURCE_ACCOUNT,
        ruleId: 3,
        networkPassphrase: 'Test SDF Network ; September 2015',
        rpc: mock,
      })
    ).rejects.toThrow('revoke_policy: auth simulateTransaction failed')
    expect(mock.simulateCalls).toHaveLength(2)
  })
})

// ---- schema fix regressions ----

describe('PredicateLeafSchema fixes (regression coverage)', () => {
  it('rejects a non-hex literal_bytes value (silently-truncated bug)', async () => {
    const { PredicateLeafSchema } = await import('./schemas.ts')
    // 'zzzz' is what the orchestrator confirmed would silently truncate
    // to an empty buffer with the old regex `z.string()`.
    expect(PredicateLeafSchema.safeParse({ kind: 'literal_bytes', value: 'zzzz' }).success).toBe(
      false
    )
  })

  it('rejects literal_u32 > U32_MAX', async () => {
    const { PredicateLeafSchema } = await import('./schemas.ts')
    expect(PredicateLeafSchema.safeParse({ kind: 'literal_u32', value: 4294967296 }).success).toBe(
      false
    )
  })

  it('accepts literal_u32 = U32_MAX', async () => {
    const { PredicateLeafSchema } = await import('./schemas.ts')
    expect(PredicateLeafSchema.safeParse({ kind: 'literal_u32', value: 4294967295 }).success).toBe(
      true
    )
  })
})

// ---- get_interpreter_info pure logic ----

describe('getInterpreterInfo pure logic', () => {
  it('omits liveMatchesPin when no deployedGrammarVersion is supplied', async () => {
    const { getInterpreterInfo } = await import('../install/get-interpreter-info.ts')
    const info = getInterpreterInfo({
      pinnedAddress: 'CDR4NLV22STCXFGZPNKDQTEANWLF7LZ6AJLY6B7CLJXKHDZGYJWIOKGP',
      pinnedGrammarVersion: 1,
      pinnedWasmHash: '6e6c13d93e197aa380303a42cd120f5ddb080dd36ef2a343ee1dbd04ca52a443',
      network: 'testnet',
    })
    expect(info.deployedGrammarVersion).toBeUndefined()
    expect(info.liveMatchesPin).toBeUndefined()
  })

  it('sets liveMatchesPin=true when the deployed version matches the pin', async () => {
    const { getInterpreterInfo } = await import('../install/get-interpreter-info.ts')
    const info = getInterpreterInfo({
      pinnedAddress: 'CDR4NLV22STCXFGZPNKDQTEANWLF7LZ6AJLY6B7CLJXKHDZGYJWIOKGP',
      pinnedGrammarVersion: 1,
      pinnedWasmHash: '6e6c13d93e197aa380303a42cd120f5ddb080dd36ef2a343ee1dbd04ca52a443',
      network: 'testnet',
      deployedGrammarVersion: 1,
    })
    expect(info.deployedGrammarVersion).toBe(1)
    expect(info.liveMatchesPin).toBe(true)
  })

  it('sets liveMatchesPin=false when the deployed version differs from the pin', async () => {
    const { getInterpreterInfo } = await import('../install/get-interpreter-info.ts')
    const info = getInterpreterInfo({
      pinnedAddress: 'CDR4NLV22STCXFGZPNKDQTEANWLF7LZ6AJLY6B7CLJXKHDZGYJWIOKGP',
      pinnedGrammarVersion: 1,
      pinnedWasmHash: '6e6c13d93e197aa380303a42cd120f5ddb080dd36ef2a343ee1dbd04ca52a443',
      network: 'testnet',
      deployedGrammarVersion: 2,
    })
    expect(info.deployedGrammarVersion).toBe(2)
    expect(info.liveMatchesPin).toBe(false)
  })
})

// ---- Pinning gates (default-deny) ----
//
// The interpreter address on every interpreter policy MUST match the
// pinned testnet address - a caller that controls the interpreter can
// permit anything. The RPC URL must match the pinned testnet endpoint -
// the auth nonce + rootInvocation in the response come from whichever
// RPC answered. Both gates default-deny; an explicit opt-in flag lets
// a developer override when they actually want to point at a custom
// deployment / RPC.

describe('install_policy pinning (default-deny)', () => {
  // Build a rule that pins the interpreter to the pinned testnet address,
  // so the RPC pin gate is the one being exercised (not the interpreter
  // pin gate, which would otherwise fire first).
  function pinnedRule() {
    const m = makeRule()
    return {
      ...m.rule,
      policies: [
        {
          kind: 'interpreter' as const,
          interpreterAddress: PINNED_INTERPRETER_TESTNET_ADDRESS,
          predicateBlobBase64: m.encodedPredicate,
        },
      ],
    }
  }

  it('refuses a non-pinned interpreter policy unless allowUnpinnedInterpreter is set', async () => {
    const m = makeRule()
    const input = {
      ...makeValidInstallInput(),
      rule: {
        ...m.rule,
        // Point at a fresh, caller-controlled interpreter address. The
        // pinned pin would otherwise authorise only the contract the
        // team deployed; anything else is a redirect-the-authority attack.
        policies: [
          {
            kind: 'interpreter' as const,
            interpreterAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            predicateBlobBase64: m.encodedPredicate,
          },
        ],
      },
    }
    const res = await runInstallPolicy(input)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('INSTALL_BUILD_FAILED')
    expect(res.error.message).toContain('pinned')
    expect(res.error.message).toContain(PINNED_INTERPRETER_TESTNET_ADDRESS)
  })

  it('fills the synthesizer placeholder with the pinned interpreter', async () => {
    const m = makeRule()
    const input = {
      ...makeValidInstallInput(),
      rule: {
        ...m.rule,
        policies: [
          {
            kind: 'interpreter' as const,
            interpreterAddress: PLACEHOLDER_INTERPRETER_ADDRESS,
            predicateBlobBase64: m.encodedPredicate,
          },
        ],
      },
      // Stop the call at the RPC pin, one gate PAST the interpreter pin. A
      // rule still carrying the placeholder fails the interpreter pin first
      // and names it, which is what every synthesized rule did before install
      // filled the marker in.
      rpcUrl: 'https://soroban.example.invalid/',
    }
    const res = await runInstallPolicy(input)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.message).not.toContain(PLACEHOLDER_INTERPRETER_ADDRESS)
    expect(res.error.message).toContain(TESTNET_RPC_URL)
  })

  it('accepts a non-pinned interpreter policy when allowUnpinnedInterpreter=true', async () => {
    const m = makeRule()
    const input = {
      ...makeValidInstallInput(),
      rule: {
        ...m.rule,
        policies: [
          {
            kind: 'interpreter' as const,
            interpreterAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            predicateBlobBase64: m.encodedPredicate,
          },
        ],
      },
      allowUnpinnedInterpreter: true,
      rpcUrl: 'http://127.0.0.1:1/should-not-connect',
      allowUnpinnedRpcUrl: true,
    }
    // The envelope gets past the pinning gate; the RPC is unreachable,
    // so the run-layer throws inside `buildRpcClientFromInput` and the
    // envelope returns INSTALL_BUILD_FAILED with NO host detail. The
    // important assertion is that the pinning gate did NOT refuse this
    // call BEFORE the RPC failed.
    const res = await runInstallPolicy(input)
    expect(res.ok).toBe(false)
    if (res.ok) return
    // Either the RPC envelope fires or the inner builder refuses -
    // either way the message MUST NOT contain the pinned-pin phrase
    // (that would mean the pin gate fired despite the opt-in).
    expect(res.error.message).not.toMatch(/pinned/)
  })

  it('refuses a non-pinned rpcUrl unless allowUnpinnedRpcUrl is set', async () => {
    const input = {
      ...makeValidInstallInput(),
      rule: pinnedRule(),
      rpcUrl: 'https://soroban.example.invalid/',
    }
    const res = await runInstallPolicy(input)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('INSTALL_BUILD_FAILED')
    expect(res.error.message).toContain(TESTNET_RPC_URL)
    expect(res.error.message).not.toContain('soroban.example.invalid')
  })

  it('accepts the pinned rpcUrl without an opt-in flag', async () => {
    const input = {
      ...makeValidInstallInput(),
      rule: pinnedRule(),
      rpcUrl: TESTNET_RPC_URL,
    }
    // The RPC at TESTNET_RPC_URL is unreachable in CI; what matters is
    // that the pin gate did NOT refuse BEFORE the RPC was tried.
    const res = await runInstallPolicy(input)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.message).not.toContain('TESTNET_RPC_URL')
    expect(res.error.message).not.toMatch(/pinned/)
  })
})

describe('revoke_policy RPC pinning (default-deny)', () => {
  it('refuses a non-pinned rpcUrl unless allowUnpinnedRpcUrl is set', async () => {
    const input = {
      ...makeValidRevokeInput(),
      rpcUrl: 'https://soroban.example.invalid/',
    }
    const res = await runRevokePolicy(input)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('REVOKE_BUILD_FAILED')
    expect(res.error.message).toContain(TESTNET_RPC_URL)
    expect(res.error.message).not.toContain('soroban.example.invalid')
  })

  it('refuses a non-pinned rpcUrl on network=mainnet with the mainnet pin in the message', async () => {
    const input = {
      ...makeValidRevokeInput(),
      network: 'mainnet' as const,
      rpcUrl: 'https://soroban.example.invalid/',
    }
    const res = await runRevokePolicy(input)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('REVOKE_BUILD_FAILED')
    expect(res.error.message).toContain(MAINNET_RPC_URL)
    expect(res.error.message).not.toContain('soroban.example.invalid')
  })
})

// ---- Per-network pin selection (network-aware install/revoke gates) ----
//
// Mainnet was deployed 2026-08-04. The gate no longer hardcodes testnet
// everywhere - it picks the pin and RPC for the network the caller asked
// for (defaulting to testnet so pre-mainnet callers keep working without
// changes). The new failure mode is the exact inverse of the old one: a
// caller passing `network: 'mainnet'` must now reach for the MAINNET pins,
// not the testnet ones, or the gate refuses them.

describe('install_policy network-aware pinning', () => {
  it('accepts the mainnet interpreter address when network=mainnet', async () => {
    const m = makeRule()
    const input = {
      ...makeValidInstallInput(),
      network: 'mainnet' as const,
      rule: {
        ...m.rule,
        policies: [
          {
            kind: 'interpreter' as const,
            interpreterAddress: PINNED_INTERPRETER_MAINNET_ADDRESS,
            predicateBlobBase64: m.encodedPredicate,
          },
        ],
      },
      rpcUrl: MAINNET_RPC_URL,
    }
    // Pin and RPC pass; the live RPC is unreachable in CI, so the call
    // either fails at the RPC layer or succeeds. The important assertion
    // is that the gate did NOT refuse BEFORE the RPC was tried.
    const res = await runInstallPolicy(input)
    if (res.ok) {
      // If a CI runner has outbound to mainnet, this is a full success.
      return
    }
    expect(res.error.message).not.toContain('pinned')
    expect(res.error.message).not.toContain('TESTNET_RPC_URL')
  })

  it('refuses the mainnet interpreter address when network=testnet', async () => {
    const m = makeRule()
    const input = {
      ...makeValidInstallInput(),
      // Default network (testnet) but pointing at the MAINNET pin: an
      // attacker could pass an unaudited address this way; the gate has
      // to compare against the network's own pin, not just "any pin".
      rule: {
        ...m.rule,
        policies: [
          {
            kind: 'interpreter' as const,
            interpreterAddress: PINNED_INTERPRETER_MAINNET_ADDRESS,
            predicateBlobBase64: m.encodedPredicate,
          },
        ],
      },
    }
    const res = await runInstallPolicy(input)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('INSTALL_BUILD_FAILED')
    expect(res.error.message).toContain('pinned')
    expect(res.error.message).toContain(PINNED_INTERPRETER_TESTNET_ADDRESS)
  })

  it('refuses a non-pinned rpcUrl on network=mainnet unless allowUnpinnedRpcUrl is set', async () => {
    const m = makeRule()
    const input = {
      ...makeValidInstallInput(),
      network: 'mainnet' as const,
      rule: {
        ...m.rule,
        policies: [
          {
            kind: 'interpreter' as const,
            interpreterAddress: PINNED_INTERPRETER_MAINNET_ADDRESS,
            predicateBlobBase64: m.encodedPredicate,
          },
        ],
      },
      rpcUrl: 'https://soroban.example.invalid/',
    }
    const res = await runInstallPolicy(input)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('INSTALL_BUILD_FAILED')
    expect(res.error.message).toContain(MAINNET_RPC_URL)
    expect(res.error.message).not.toContain('soroban.example.invalid')
  })

  it('defaults to the testnet pin when no network is supplied (backward compat)', async () => {
    // Existing pre-mainnet callers pass no network; they were pointing
    // at the testnet interpreter, so the gate MUST keep enforcing the
    // testnet pin by default. This is the deny-by-default invariant:
    // absence of a network claim does not unlock the gate.
    const m = makeRule()
    const input = {
      ...makeValidInstallInput(),
      rule: {
        ...m.rule,
        // A throwaway address that is NOT either pinned pin. The gate
        // must refuse it with the TESTNET pin in the message.
        policies: [
          {
            kind: 'interpreter' as const,
            interpreterAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            predicateBlobBase64: m.encodedPredicate,
          },
        ],
      },
    }
    const res = await runInstallPolicy(input)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.code).toBe('INSTALL_BUILD_FAILED')
    expect(res.error.message).toContain(PINNED_INTERPRETER_TESTNET_ADDRESS)
  })
})

// ---- describes field decoded from built XDR ----
//
// The install envelope must describe the call it actually built, not
// the caller's intent. The describes field is decoded FROM the XDR so a
// human approving a review card approves what the wallet will sign.

describe('install_policy describes (decoded from XDR)', () => {
  it('reports target contract, rule name, signers, policies, install nonce, and the embedded predicate hash', async () => {
    // Drive the lower-level builder directly with a mock so we can
    // assert on the wire-shape-derived description without the RPC
    // client dependency.
    const { buildInstallPolicyXdr } = await import('../install/build-install-policy.ts')
    const mock = mockRpcClient()
    const m = makeRule()
    const result = await buildInstallPolicyXdr({
      smartAccount: SMART_ACCOUNT,
      sourceAccount: SOURCE_ACCOUNT,
      networkPassphrase: 'Test SDF Network ; September 2015',
      rule: m.rule,
      installNonce: 1,
      encodedPredicate: m.encodedPredicate,
      predicateHash: m.predicateHash,
      rpc: mock,
    })
    expect(result.describes.targetContract).toBe(SMART_ACCOUNT)
    expect(result.describes.fnName).toBe('add_context_rule')
    expect(result.describes.ruleName).toBe('test-rule')
    expect(result.describes.validUntilLedger).toBeNull()
    expect(result.describes.signers).toEqual([{ kind: 'delegated', address: SOURCE_ACCOUNT }])
    expect(result.describes.policies).toHaveLength(1)
    const policy = result.describes.policies[0]!
    expect(policy.kind).toBe('interpreter')
    if (policy.kind !== 'interpreter') return
    // The mock wires `interpreterAddress: SMART_ACCOUNT`, so the
    // describes field MUST echo it back (even though SMART_ACCOUNT is
    // not a real interpreter address - this is a pure wire test).
    expect(policy.address).toBe(SMART_ACCOUNT)
    expect(policy.installNonce).toBe(1)
    // The hash on the wire MUST match the hash we computed from the
    // predicate bytes the builder embedded; the run-layer re-hashes
    // them and reports both numbers so a human can verify.
    expect(policy.predicateHash).toBe(m.predicateHash)
    expect(policy.predicateSha256OfEmbeddedBytes).toBe(m.predicateHash)
    expect(result.describes.installNonce).toBe(1)
  })

  it('reflects a tampering change in input -> describes reflects the change', async () => {
    const { buildInstallPolicyXdr } = await import('../install/build-install-policy.ts')
    const mock = mockRpcClient()
    const m = makeRule()
    // Tamper: bump the install nonce from 1 to 5. The describes field
    // must follow because it is decoded from the XDR, not the input.
    const result = await buildInstallPolicyXdr({
      smartAccount: SMART_ACCOUNT,
      sourceAccount: SOURCE_ACCOUNT,
      networkPassphrase: 'Test SDF Network ; September 2015',
      rule: m.rule,
      installNonce: 5,
      encodedPredicate: m.encodedPredicate,
      predicateHash: m.predicateHash,
      rpc: mock,
    })
    expect(result.describes.installNonce).toBe(5)
    const policy = result.describes.policies[0]!
    expect(policy.kind).toBe('interpreter')
    if (policy.kind !== 'interpreter') return
    expect(policy.installNonce).toBe(5)
  })
})

describe('get_interpreter_info - mainnet honesty', () => {
  it('returns the mainnet pin on network=mainnet (no longer refuses)', async () => {
    // Mainnet was deployed 2026-08-04. Returning the mainnet pin is the
    // same call shape that previously refused with "no interpreter is
    // deployed to mainnet" - that claim is no longer true.
    const res = await runGetInterpreterInfo({ network: 'mainnet' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.pinnedAddress).toBe(PINNED_INTERPRETER_MAINNET_ADDRESS)
    expect(res.data.network).toBe('mainnet')
    // Shared wasm hash: same binary was uploaded both places.
    expect(res.data.pinnedWasmHash).toBe(PINNED_INTERPRETER_WASM_SHA256)
  })

  it('still answers for testnet', async () => {
    const res = await runGetInterpreterInfo({ network: 'testnet' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.pinnedAddress).toBe(PINNED_INTERPRETER_TESTNET_ADDRESS)
  })

  it('defaults to the testnet pin when network is omitted', async () => {
    const res = await runGetInterpreterInfo({})
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.pinnedAddress).toBe(PINNED_INTERPRETER_TESTNET_ADDRESS)
    expect(res.data.network).toBe('testnet')
  })
})
