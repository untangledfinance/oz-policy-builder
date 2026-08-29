// packages/policy-builder-mcp/src/server.ts
//
// Registers the T1 tool surface on a fresh McpServer instance. The
// registration uses the official MCP SDK's `tool()` API with ZodRawShape
// schemas (the SDK does not accept ZodEffects / discriminated unions at the
// tool registration boundary - the known gotcha). The body re-validates
// against the strict discriminated union in `@crediolabs/policy-synth/run`
// so wire inputs still fail closed.
//
// Stateless: a fresh McpServer is constructed per transport (stdio/HTTP). No
// shared mutable state across calls; nothing here caches, queues, or holds
// key material.

import type { ToolResponse } from '@crediolabs/policy-synth'
import {
  runDeclarePolicy,
  runGetInterpreterInfo,
  runInstallPolicy,
  runRecordTransaction,
  runRevokePolicy,
  runSimulatePolicy,
  runSynthesizePolicy,
  runVerifyPolicy,
} from '@crediolabs/policy-synth/run'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  DeclarePolicyToolShape,
  GetInterpreterInfoToolShape,
  InstallPolicyToolShape,
  RecordTransactionToolShape,
  RevokePolicyToolShape,
  SimulatePolicyToolShape,
  SynthesizePolicyToolShape,
  VerifyPolicyToolShape,
} from './schemas.ts'
import { mcpResultFromCore } from './tools/result.ts'

/** Our envelope types `structuredContent` precisely (T / ToolError); the SDK's
 *  CallToolResult widens it to Record<string, unknown>, so the nominal types
 *  do not overlap. The runtime shapes match, so we assert through `unknown`
 *  at the transport boundary - in one place, used by every tool. */
const toCallToolResult = <T>(
  res: ToolResponse<T> | (ToolResponse<T> & Record<string, unknown>)
): CallToolResult => mcpResultFromCore(res as ToolResponse<T>) as unknown as CallToolResult

/** Build a fresh, stateless MCP server. The caller owns the returned object
 *  and connects it to a single transport (stdio or Streamable HTTP). */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    // Kept in step with package.json by `server-version.test.ts`. It was
    // hardcoded once already and reported 0.0.0 to every client; a literal is
    // fine, a literal nothing checks is not.
    { name: 'policy-builder-mcp', version: '1.1.0' },
    { capabilities: { tools: {} } }
  )
  registerTools(server)
  return server
}

/** Idempotent registration of the T1 tool set on the given server. */
export function registerTools(server: McpServer): void {
  server.tool(
    'record_transaction',
    'Decode a Soroban transaction (on-chain hash OR base64 envelope XDR) into a RecordedTransaction. Returns a machine-readable ToolError on validation failure.',
    RecordTransactionToolShape,
    (args) => runRecordTransaction(args).then(toCallToolResult)
  )

  server.tool(
    'synthesize_policy',
    'Synthesize a ProposedPolicy from a recorded transaction (`source: recording`). Pass `transactionHash` and `network` to have the server re-record and synthesize in one step - prefer this over copying a `recordedTx` payload back out of a previous tool result, which loses fields. `recordedTx` remains accepted for programmatic callers holding the object.',
    SynthesizePolicyToolShape,
    (args) => runSynthesizePolicy(args).then(toCallToolResult)
  )

  server.tool(
    'simulate_policy',
    'Evaluate a predicate against one recorded call and report permit/deny with the deny reason. The evaluator is a second implementation of the on-chain semantics, cross-checked against the Rust interpreter by the conformance harness, so a verdict here is a claim about what the contract would do. Pass `transactionHash` with `smartAccount` and the server records and synthesizes the predicate itself; or pass a predicate together with the call to check it against. For a predicate you already hold, pass `encodedPredicate` (the base64 string `declare_policy` and `synthesize_policy` return) rather than retyping the `predicate` tree.',
    SimulatePolicyToolShape,
    (args) => runSimulatePolicy(args).then(toCallToolResult)
  )

  server.tool(
    'verify_policy',
    'Check a predicate against the transaction it was synthesised from, plus a generated deny case per dimension. Reports `ok` only when the permit case is permitted AND every deny case is denied - a denied permit case means the policy is too strict, a permitted deny case means it is too loose. Pass `transactionHash` with `smartAccount` and the server rebuilds the predicate and the recording itself; For a predicate you already hold - a DECLARED one has no recording behind it, so re-synthesizing would check something else - pass `encodedPredicate` (the base64 string) with `transactionHash`. Retyping the `predicate` tree is the error-prone path; do not take it, and never skip this check because the tree was not to hand.',
    VerifyPolicyToolShape,
    (args) => runVerifyPolicy(args).then(toCallToolResult)
  )

  server.tool(
    'declare_policy',
    "Build an interpreter predicate from a DECLARED constraint - the method to pin, and optionally the contract, a per-call amount cap, a recipient allowlist, and a minimum-output ratio (a swap slippage floor, bounding the output argument against the call's own input). Use this when there is no transaction to record, or when `record_transaction` refuses a contract it does not recognise. Returns the predicate tree, its canonical encoding and hash, ready for `install_policy`. `warnings` names any argument index that was GUESSED rather than supplied - a bound on the wrong argument constrains nothing while looking correct, so read them. There is no rolling spend window and no approval threshold: neither is expressible in grammar 4, and both belong to the OpenZeppelin account layer.",
    DeclarePolicyToolShape,
    (args) => Promise.resolve(runDeclarePolicy(args)).then(toCallToolResult)
  )

  server.tool(
    'install_policy',
    'Build an UNSIGNED Soroban transaction XDR for `account.add_context_rule(...)` that installs a new policy rule on the given smart account. Name the rule ONE of three ways. `fromPredicate: { encodedPredicate, signers }` installs a predicate you already hold - the base64 string `declare_policy` returns - and scopes the rule to whatever contract that predicate pins. `fromHash: { transactionHash, signers }` - with `fromHash` the server re-synthesizes the rule from the recording itself, and `signers` (plain G.../C... addresses) names the keys the rule governs. Naming them is required: synthesis reads a transaction and cannot decide which keys a rule binds, and a rule that governs no key is refused on chain. `rule` is the full ContextRuleDraft and is for programmatic callers only - retyping it loses the types of `validUntilLedger`, `signers` and `policies`. In BOTH handle forms `signers` is a list of plain Stellar account addresses (G...): a delegated signer is an account, NOT a deployed signer contract, and nothing needs to be deployed to name one. The response carries an `authorityScan`: every rule already on the account that a signer of this install could name INSTEAD, including an unpoliced one against which the predicate never runs - a predicate only constrains a key when the policed rule is the only rule that key is on. The account is READ over RPC to build it; pass `existingRules` to supply them yourself instead (useful offline). `authorityScan: null` means NOT CHECKED - the read failed, or it could not account for every live rule - and must never be read as "nothing found". The wallet signs the returned XDR - the signature IS the user-confirmation step (this server is stateless and holds no key material, so there is no two-call confirm pair). `installNonce` defaults to 1, which is correct for a fresh rule - do not ask the caller for it. If the recorded call spends an amount and no `limitAmount` is given, the install is REFUSED: such a rule would constrain everything about the call except how much it moves, and it would install and verify cleanly while capping nothing. Supply `fromHash.userResponses.limitAmount`, or `allowUnboundedAmount: true` to do it deliberately. For a ROLLING TOTAL - "at most N per day" - pass `spendingLimit: { amount, periodLedgers }`. It attaches an OpenZeppelin `spending_limit` beside the predicate on the same rule, and both must permit. A predicate alone CANNOT express a rolling total: the interpreter is handed one call and keeps no state, so a per-call cap of N authorises N again on the very next call. The window counts LEDGERS (about five seconds each), and the rule must be scoped to the token contract whose transfers it meters. One transaction is all it takes: the smart account calls the interpreter `install` itself while running `add_context_rule`, so once this XDR is signed and submitted the rule is live and the predicate is enforced. The rule id the account assigned is in the transaction result. Do not tell the caller a second call is outstanding.',
    InstallPolicyToolShape,
    (args) => runInstallPolicy(args).then(toCallToolResult)
  )

  server.tool(
    'revoke_policy',
    'Build an UNSIGNED Soroban transaction XDR for `account.remove_context_rule(ruleId)` that removes a policy rule from the given smart account. The smart account handles uninstalling each attached policy itself. Auth is master-only - the source account MUST be the master signer set; delegated signers cannot uninstall.',
    RevokePolicyToolShape,
    (args) => runRevokePolicy(args).then(toCallToolResult)
  )

  server.tool(
    'get_interpreter_info',
    'Read-only fingerprint lookup for the policy interpreter contract: returns the pinned address, grammar version, and wasm sha256 (from the pinned constants + SELF_VERSION). When `verifyLive=true`, performs an additional `grammar_version()` RPC call against the pinned address and reports whether the deployed contract matches the pin - a live mismatch check is more useful than a fabricated audit field.',
    GetInterpreterInfoToolShape,
    (args) => runGetInterpreterInfo(args).then(toCallToolResult)
  )
}
