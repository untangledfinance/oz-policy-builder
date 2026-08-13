// packages/policy-builder-mcp/src/tools/result.ts
//
// Transport-layer mapping between the core's ToolResponse<T> envelope and the
// MCP result envelope. This is the ONLY place the two envelopes meet; no
// business logic lives here. The shapes follow the MCP spec for the
// `CallToolResult` type:
//
//   success:  { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false }
//   failure:  { content: [{ type: 'text', text: JSON.stringify(error) }], isError: true }
//
// Both branches carry the structured content as a single JSON-encoded text
// block so clients that do not parse `structuredContent` still see a usable
// payload. The shape is intentionally tiny - any extra keys belong in the
// core, not here.

import type { ToolError, ToolResponse } from '@crediolabs/policy-synth'

export interface McpToolSuccess<T> {
  isError: false
  content: Array<{ type: 'text'; text: string }>
  structuredContent: T
}

export interface McpToolError {
  isError: true
  content: Array<{ type: 'text'; text: string }>
  structuredContent: ToolError
}

export type McpToolResult<T> = McpToolSuccess<T> | McpToolError

/** Map a core ToolResponse<T> to the MCP result envelope. The handler in
 *  src/server.ts wraps this in the SDK's `{ content, isError }` shape. */
export function mcpResultFromCore<T>(res: ToolResponse<T>): McpToolResult<T> {
  if (!res.ok) return mcpErrorFromCore(res.error)
  return {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify(res.data) }],
    structuredContent: res.data,
  }
}

/** Map a core ToolError directly (for inputs that already failed validation
 *  inside the handler). */
export function mcpErrorFromCore(err: ToolError): McpToolError {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(err) }],
    structuredContent: err,
  }
}
