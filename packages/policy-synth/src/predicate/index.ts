// src/predicate/index.ts - re-export the canonical predicate encoder and the
// untrusted-JSON parser that feeds it. A consumer accepting a hand-written
// policy needs both halves.

export { decodeLeaf, decodeNode, decodePredicate } from './decode.ts'
export { type EncodedPredicate, encodePredicate } from './encode.ts'
export { jsonToAst } from './from-json.ts'
