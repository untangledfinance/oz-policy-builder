// src/verify/index.ts - re-export the simulation / verification surface.

export type { SimulationResult } from './envelope.ts'
export { type SimulateOptions, simulatePolicy } from './simulate.ts'
export { type VerifyOptions, verifyPolicy } from './verify.ts'
