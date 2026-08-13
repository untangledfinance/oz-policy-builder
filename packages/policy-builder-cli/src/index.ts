// packages/policy-builder-cli/src/index.ts - public re-exports for the CLI package.

export { runRecordCommand } from './commands/record.ts'
export { runSynthesizeCommand } from './commands/synthesize.ts'
export { formatToolResponse, readJsonFile, writeJsonFile } from './output.ts'
