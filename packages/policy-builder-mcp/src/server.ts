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
    'Synthesize a ProposedPolicy from either a deterministic MandateSpec (`source: mandate`) or a RecordedTransaction (`source: recording`). The discriminated `source` field selects the front-end.',
    SynthesizePolicyToolShape,
    (args) => runSynthesizePolicy(args).then(toCallToolResult)
  )

  server.tool(
    'simulate_policy',
    'Replay a RecordedTransaction against a proposed PredicateNode (or null for an OZ-only policy) and emit the SimulationResult envelope (permit verdict + deny-case battery). Returns a SIMULATION_ERROR ToolError on runtime evaluation failure.',
    SimulatePolicyToolShape,
    (args) => runSimulatePolicy(args).then(toCallToolResult)
  )

  server.tool(
    'verify_policy',
    'Run the static minimality check on a proposed PredicateNode against a RecordedTransaction (no conjunct is load-bearing-free). Returns VERIFICATION_FAILED with the dropped-constraint fingerprints when the predicate is over-broad.',
    VerifyPolicyToolShape,
    (args) => runVerifyPolicy(args).then(toCallToolResult)
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
