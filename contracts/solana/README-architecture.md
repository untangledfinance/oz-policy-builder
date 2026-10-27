# Prime on Solana: no program of ours

This folder holds no Solana program. Prime on Solana is configuration of
programs that other teams wrote and deployed: the Squads Smart Account, SPL
Token and Token-2022, and the venue's own programs (Kamino klend and Scope for
lending). Off-chain helpers build, check and co-sign transactions; none of
them holds custody's funds. The design, the setup, recovery and the limits are
in [docs/solana.md](../../docs/solana.md), and
[docs/architecture.md](../../docs/architecture.md) shows how it fits with
Stellar and EVM.

## What was here before

Until 27 October 2026 this folder held two programs of ours and their guides:

| Program | Devnet id | What took its place |
|---|---|---|
| Custody gate (`custody-gate`) | `6ieR7WUs2M2VxEFYosRLuMtCdrWs7sqUeM1P4d5jiUnz` | A Squads Smart Account owned by custody's signers and a trustee. Its vault owns custody's token accounts, and its rules pay only pinned destinations under a cap ([the custody account](../../docs/solana.md#custody-account)) |
| Seat program (`prime-seat`) | `7ygNrKpK3GYoNLMCkAa4e3mznGPF2KVGbKZsJcq8wSCb` | Nothing: each owner signs as a Squads signer with its own key, and there are no seats or session keys on Solana ([owners](../../docs/solana.md#owners)) |

Both programs were deployed with `--final`, so they stay on devnet with no
upgrade authority. Nothing in this design calls them. Their source, tests,
app checks, build hashes and the setup guide are in this repository's history
at commit `89f7839` on `feat/primex`, and the earlier spike runs are at tag
`archive/spike-final`. Neither program was ever deployed to mainnet.
