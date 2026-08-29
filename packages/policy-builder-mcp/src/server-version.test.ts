// src/server-version.test.ts - the version the server reports to clients is the
// version that was published.
//
// This drifted before: `serverInfo.version` was hardcoded and answered `0.0.0`
// to every client regardless of what was installed. Fixing the literal without
// pinning it just moves the drift to the next release - a bump that updates
// package.json and forgets the server reports the previous version, which is
// worse than 0.0.0 because it looks plausible.

import { describe, expect, it } from 'bun:test'
import pkg from '../package.json' with { type: 'json' }
import { createMcpServer } from './server.ts'

describe('serverInfo', () => {
  it('reports the package version', () => {
    const server = createMcpServer()
    // The SDK keeps the registered implementation on the underlying server.
    const info = (server.server as unknown as { _serverInfo?: { name: string; version: string } })
      ._serverInfo
    expect(info?.name).toBe('policy-builder-mcp')
    expect(info?.version).toBe(pkg.version)
  })
})
