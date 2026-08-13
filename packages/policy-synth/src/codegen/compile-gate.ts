// src/codegen/compile-gate.ts - toolchain-gated `cargo check` for the
// codegen escape hatch.
//
// The escape hatch ships as the `policy-builder escape-hatch` CLI subcommand
// (a later phase). This gate is its safety net, NOT the happy path. Property:
// generated Rust compiles against the pinned OZ crate; broken source returns
// `COMPILE_GATE_FAILED` with `stderr`; an absent toolchain returns `SKIPPED`
// (does NOT fail - we cannot make build tools a hard runtime requirement for
// a TypeScript package).

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type CompileGateResult =
  | { code: 'COMPILE_OK' }
  | { code: 'COMPILE_GATE_FAILED'; stderr: string }
  | { code: 'SKIPPED'; reason: string }

export interface CompileGateOpts {
  /** Caller-controlled abort signal; aborting before toolchain probe resolves
   *  the gate to `SKIPPED` rather than starting a cargo invocation. */
  signal?: AbortSignal
  /** Override the `cargo` binary (mostly for tests). */
  cargoBin?: string
  /** Override the target directory (mostly for tests). */
  tempDir?: string
}

interface ToolchainProbe {
  present: boolean
  reason: string
}

/** Probe the host for the Rust toolchain the gate requires. We require BOTH
 *  `cargo` AND `stellar` (the Soroban CLI) because a real gate run invokes
 *  `stellar contract build`; absent either, the gate returns `SKIPPED`. */
export async function hasRustToolchain(): Promise<boolean> {
  const probe = await probeToolchain()
  return probe.present
}

async function probeToolchain(): Promise<ToolchainProbe> {
  const cargo = await which('cargo')
  if (!cargo) return { present: false, reason: 'cargo not found on PATH' }
  const stellar = await which('stellar')
  if (!stellar) return { present: false, reason: 'stellar not found on PATH' }
  return { present: true, reason: `${cargo} + ${stellar}` }
}

async function which(bin: string): Promise<string | null> {
  try {
    const out = await runProcess('sh', ['-c', `command -v ${bin}`], { capture: true })
    const path = out.stdout.trim()
    return path.length > 0 ? path : null
  } catch {
    return null
  }
}

interface RunOpts {
  capture?: boolean
  signal?: AbortSignal
}

function runProcess(
  cmd: string,
  args: string[],
  opts: RunOpts
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8')
    })
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8')
    })
    const onAbort = () => {
      child.kill('SIGTERM')
      reject(new Error('aborted'))
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ stdout, stderr, code: code ?? -1 })
    })
  })
}

const CARGO_MANIFEST = `[package]
name = "escape-hatch-gate"
version = "0.0.0"
edition = "2021"
publish = false

[lib]
crate-type = ["cdylib"]
# The gate writes the source beside the manifest rather than under src/, so
# the path is stated. Without it cargo looks for src/lib.rs and fails to
# parse the manifest before it ever compiles anything, which reads as a
# broken generator rather than a broken scaffold.
path = "lib.rs"

[dependencies]
soroban-sdk = "22"

[workspace]
`

/** Compile-check a Rust source string against the pinned Soroban SDK.
 *
 *  - Toolchain absent -> `{ code: 'SKIPPED', reason }` (NOT a failure).
 *  - Toolchain present, source compiles -> `{ code: 'COMPILE_OK' }`.
 *  - Toolchain present, source broken -> `{ code: 'COMPILE_GATE_FAILED', stderr }`.
 *
 *  The gate writes the source to a temporary crate and runs `cargo check`
 *  against it; the crate is cleaned up whether or not compilation succeeds.
 *  The caller is expected to surface `COMPILE_GATE_FAILED.stderr` to the
 *  user (the LLM agent) so the user can iterate. */
export async function compileCheck(
  rustSource: string,
  opts: CompileGateOpts = {}
): Promise<CompileGateResult> {
  if (opts.signal?.aborted) {
    return { code: 'SKIPPED', reason: 'aborted before probe' }
  }

  const probe = await probeToolchain()
  if (!probe.present) {
    return { code: 'SKIPPED', reason: probe.reason }
  }

  let dir: string | null = null
  try {
    dir = await mkdtemp(join(opts.tempDir ?? tmpdir(), 'codegen-gate-'))
    await writeFile(join(dir, 'Cargo.toml'), CARGO_MANIFEST)
    await writeFile(join(dir, 'lib.rs'), rustSource)

    const runOpts: RunOpts = opts.signal ? { signal: opts.signal } : {}
    const result = await runProcess(
      opts.cargoBin ?? 'cargo',
      ['check', '--quiet', '--offline', '--manifest-path', join(dir, 'Cargo.toml')],
      runOpts
    ).catch((e: Error) => ({ stdout: '', stderr: e.message, code: -1 }))

    if (result.code === 0) {
      return { code: 'COMPILE_OK' }
    }
    return { code: 'COMPILE_GATE_FAILED', stderr: result.stderr || result.stdout }
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
