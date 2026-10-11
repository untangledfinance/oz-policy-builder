# Beta sessions proofs

Chain proofs for Prime sessions on the Stellar and EVM betas, run on 11 October 2026. They exercise the deployed `prime-session` wasm on Stellar testnet and `PrimeSession.sol` on an anvil fork of Base Sepolia.

| Folder | What it proves | Result file |
|---|---|---|
| `stellar/` | Code entry TTL, several `Delegated(prime-session)` signers in one OZ rule, predictable instance address, key TTL, start with a WebCrypto Ed25519 key, revoke, owner-only end, expiry (S1 to S7) | `stellar/results.json` |
| `evm/` | One-transaction start through Multicall3 and the CREATE2 deployer, Roles refusals, revoke, second start, grant text vectors (E1 to E7) | `evm/results.json` |

## Run

Stellar uses throwaway keys that friendbot funds. Keys are created in `secrets/` next to the scripts with mode 600 and must stay out of git.

```
cd stellar
bun proofs.ts setup && bun proofs.ts s1 && bun proofs.ts s3 && bun proofs.ts s4 with-s5 && bun proofs.ts s6 && bun proofs.ts s7
```

EVM needs a fork running on port 8548 and an octopos checkout that holds `apps/evm-web/src/core/prime-session-artifact.ts` (the scripts read the app's own onboarding and policy modules from the path set at the top of `proofs.ts`).

```
anvil --fork-url https://sepolia.base.org --port 8548 &
cd evm && bun proofs.ts
```

`gen-artifact.ts` writes the app's artifact file from the forge output in `contracts/prime/evm/prime-session`.

Testnets and a local fork only.
