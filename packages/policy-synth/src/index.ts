// The package's public surface: the tools, the codec (with `readsOf` and the rule-reference
// payload), the review card, the owner-side review of an unsigned transaction (`reviewUnsigned`,
// with `readFollowed` to read the rule a follower names; `reviewSolana` and `reviewEvm` for a
// Squads Smart Account or a Safe transaction, and `readSolanaChain`/`reviewSolanaOnChain` and
// `readEvmChain`/`reviewEvmOnChain` to check one against the chain), the
// pins, the refusal type and `ruleArgs` (the five `add_context_rule` arguments of a rule
// draft). Everything else (the builders, the scan, the deny-case derivation) is internal, so
// a refactor of it is not a breaking change.

export { card } from './card.ts'
export {
  GRAMMAR_VERSION,
  INTERPRETER,
  INTERPRETER_WASM,
  INTERPRETERS,
  type Network,
  PASSPHRASE,
  POLICY_CONTRACTS,
  RPC_URL,
  SPENDING_LIMIT,
} from './config.ts'
export { type ErrorCode, Refusal, type ToolError, type ToolResponse } from './envelope.ts'
export { type EvmReview, reviewEvm } from './evm.ts'
export { type EvmSnapshot, readEvmChain, reviewEvmOnChain } from './evm-chain.ts'
export { type RuleDraft, ruleArgs } from './install.ts'
export type { CallIntent, Constraint, Intent } from './intent.ts'
export { httpRpc, type Rpc, RpcError } from './jsonrpc.ts'
export { reviewUnsigned, type UnsignedReview } from './review.ts'
export { type Followed, readFollowed } from './rules.ts'
export { reviewSolana, type SolanaReview } from './solana.ts'
export { readSolanaChain, reviewSolanaOnChain, type SolanaSnapshot } from './solana-chain.ts'
export { run, TOOLS, type Tool } from './tools.ts'
export {
  type Caps,
  CEILINGS,
  DECODE_LIMITS,
  decode,
  type Expr,
  encode,
  encodeReference,
  fromScVal,
  hashOf,
  type Reference,
  readsOf,
  referenceOf,
  type Tagged,
  toScVal,
  type Val,
  validate,
  WireError,
} from './wire.ts'
