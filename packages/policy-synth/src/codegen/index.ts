// src/codegen/index.ts - re-export the codegen escape-hatch surface.
//
// The escape hatch is OUT of the audited happy path: the synthesiser never
// calls `generateRust` itself; the CLI subcommand (a later phase) is the only
// entry point. Keeping the surface in one file makes that boundary visible
// in import statements.

export {
  type CompileGateOpts,
  type CompileGateResult,
  compileCheck,
  hasRustToolchain,
} from './compile-gate.ts'
export {
  type EscapeHatchSpec,
  generateRust,
} from './template.ts'
