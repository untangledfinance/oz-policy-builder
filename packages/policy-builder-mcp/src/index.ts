// packages/policy-builder-mcp/src/index.ts - public re-exports for the MCP server package.

export {
  type RunRecordTransactionInput,
  type RunSynthesizePolicyInput,
  runRecordTransaction,
  runSynthesizePolicy,
} from '@crediolabs/policy-synth/run'
export {
  RecordTransactionToolShape,
  SynthesizePolicyToolShape,
} from './schemas.ts'
export { createMcpServer, registerTools } from './server.ts'
export type { McpToolError, McpToolResult } from './tools/result.ts'
export { mcpErrorFromCore, mcpResultFromCore } from './tools/result.ts'
export { startHttpServer } from './transports/http.ts'
export { startStdioServer } from './transports/stdio.ts'
