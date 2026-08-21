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
    { name: 'policy-builder-mcp', version: '0.0.0' },
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
    'Synthesize a ProposedPolicy from a RecordedTransaction (`source: recording`).',
    SynthesizePolicyToolShape,
    (args) => runSynthesizePolicy(args).then(toCallToolResult)
  )

  server.tool(
    'simulate_policy',
    'Evaluate a predicate against one recorded call and report permit/deny with the deny reason. The evaluator is a second implementation of the on-chain semantics, cross-checked against the Rust interpreter by the conformance harness, so a verdict here is a claim about what the contract would do. Pass the `predicate` returned by `synthesize_policy` under `explain`.',
    SimulatePolicyToolShape,
    (args) => toCallToolResult(runSimulatePolicy(args))
  )

  server.tool(
    'verify_policy',
    'Check a predicate against the transaction it was synthesised from, plus a generated deny case per dimension. Reports `ok` only when the permit case is permitted AND every deny case is denied - a denied permit case means the policy is too strict, a permitted deny case means it is too loose.',
    VerifyPolicyToolShape,
    (args) => toCallToolResult(runVerifyPolicy(args))
  )

  server.tool(
    'install_policy',
    'Build an UNSIGNED Soroban transaction XDR for `account.add_context_rule(...)` that installs a new policy rule on the given smart account. The wallet signs the returned XDR - the signature IS the user-confirmation step (this server is stateless and holds no key material, so there is no two-call confirm pair). Only CALL 1 is emitted; the interpreter `install` follow-up needs the rule id the account assigns in call 1 and is documented in `followUp` in the response.',
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
