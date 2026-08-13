# @crediolabs/policy-builder-cli

Command-line wrapper around
[`@crediolabs/policy-synth`](https://www.npmjs.com/package/@crediolabs/policy-synth):
record a Soroban transaction and synthesise the minimal policy that permits
exactly that flow, from a shell or a CI job.

## Install

```sh
npm install -g @crediolabs/policy-builder-cli
# or run without installing
bunx @crediolabs/policy-builder-cli record --network testnet --hash <tx>
```

The binary is `policy-builder`.

## Commands

### `record`

Decode a transaction into a `RecordedTransaction`:

```sh
policy-builder record --network mainnet --hash <transaction hash>
policy-builder record --network testnet --xdr  <base64 envelope XDR>
```

Exactly one of `--hash` (fetched over RPC) or `--xdr` (decoded locally) is
required.

### `synthesize`

Produce a `ProposedPolicy` from a recording or from a mandate file (exactly
one of the two):

```sh
policy-builder synthesize --network mainnet --recorded-tx recorded.json
policy-builder synthesize --mandate mandate.json
```

`synthesize --recorded-tx` accepts either a bare `RecordedTransaction` or the
artifact `record --out` writes, so `record --out tx.json` followed by
`synthesize --recorded-tx tx.json` works end to end. Add `--explain` to
include the human-readable review card and predicate tree in the output.

Both commands print a single JSON envelope to stdout: the result on success,
a machine-readable error object (stable `code`, `severity`, `retryable`) on
failure. That makes the output safe to pipe and to assert on in CI.

## Beyond record and synthesize

Verification, simulation, install and revoke are part of the same core; drive
them from
[`@crediolabs/policy-builder-mcp`](https://www.npmjs.com/package/@crediolabs/policy-builder-mcp)
or call `@crediolabs/policy-synth/run` directly. The CLI stays deliberately
small: the two commands that fit a pipe.

## Security model

The CLI holds no key material and signs nothing. See the
[architecture document](https://github.com/untangledfinance/oz-policy-builder/blob/main/docs/architecture.md)
for what the on-chain interpreter does and does not enforce, and the
[repository README](https://github.com/untangledfinance/oz-policy-builder#readme) for
the contracts' audit status.

## License

MIT
