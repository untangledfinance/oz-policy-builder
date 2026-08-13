# @crediolabs/policy-synth

Off-chain synthesis core for the OZ Policy Builder on Stellar. It turns a
transaction you recorded, or a mandate you can state in one sentence, into the
minimal on-chain policy that permits exactly that flow, then verifies,
simulates, and packages it for installation on an
[OpenZeppelin Stellar smart account](https://docs.openzeppelin.com/stellar-contracts).

The on-chain half is the `policy-interpreter` Soroban contract, which lives in
the same repository:
[untangledfinance/oz-policy-builder](https://github.com/untangledfinance/oz-policy-builder).

## Install

```sh
npm install @crediolabs/policy-synth
# or
bun add @crediolabs/policy-synth
```

## What it does

The `@crediolabs/policy-synth/run` entry point exposes the seven tool bodies
that also back the CLI and the MCP server:

| Function | Purpose |
| --- | --- |
| `runRecordTransaction` | Decode a Soroban transaction (on-chain hash or base64 envelope XDR) into a `RecordedTransaction`. |
| `runSynthesizePolicy` | Synthesise a `ProposedPolicy` from a recording or a deterministic `MandateSpec`. |
| `runSimulatePolicy` | Replay a recording against a proposed predicate and run the deny-case battery. |
| `runVerifyPolicy` | Static minimality check: every conjunct must be load-bearing. |
| `runInstallPolicy` | Build the unsigned `add_context_rule` transaction XDR for the smart account. |
| `runRevokePolicy` | Build the unsigned `remove_context_rule` transaction XDR. |
| `runGetInterpreterInfo` | Report the pinned interpreter address, grammar version and wasm sha256, optionally checked live over RPC. |

```ts
import { runRecordTransaction, runSynthesizePolicy } from '@crediolabs/policy-synth/run'

const recorded = await runRecordTransaction({
  network: 'testnet',
  hash: '<transaction hash>',
})
```

Every function takes untrusted input, validates it through Zod schemas, and
returns a machine-readable response envelope instead of throwing - the same
contract whether the caller is a human script, the CLI, or an agent on the
other side of MCP.

Nothing in this package holds key material. Install and revoke return
*unsigned* XDR; the wallet's signature is the confirmation step.

## Security model

The synthesiser is the convenience layer; enforcement lives on chain in the
policy interpreter, whose deployed addresses and wasm sha256 are pinned in
`src/run/schemas.ts` and checked against the live network on install. The
[architecture document](https://github.com/untangledfinance/oz-policy-builder/blob/main/docs/architecture.md)
is specific about what is and is not enforced; the audit status of the
contracts is stated in the
[repository README](https://github.com/untangledfinance/oz-policy-builder#readme).

## Related packages

- [`@crediolabs/policy-builder-cli`](https://www.npmjs.com/package/@crediolabs/policy-builder-cli) - command-line record + synthesize.
- [`@crediolabs/policy-builder-mcp`](https://www.npmjs.com/package/@crediolabs/policy-builder-mcp) - the same tools over MCP for agents.

## License

MIT
