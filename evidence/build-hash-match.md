# Build-hash match of the deployed third-party programs

*27 October 2026. Each deployed build Prime configures on a test network, compared byte for byte with a build of the source the docs cite. Devnet and Base Sepolia reads only; nothing was sent.*

Prime deploys no program on Solana and no contract on EVM, so its trust in the chain rests on the third-party builds below. Until this check, the docs matched those builds to their sources by address (EVM) and by behaviour (Solana), and PayFi's verifier pins the two Solana programs' deploy slots, which tells an upgrade apart but says nothing about the source. This page states, for each build, whether a build of the cited source gives the same bytes.

## Results

| Build | Network | Source cited | Result |
|---|---|---|---|
| Kamino klend `KLend2g3…` | Solana devnet | `Kamino-Finance/klend` `e921c64` (1.26.0) | **Fail:** devnet runs `4157037d…`; `e921c64` builds to `976f1c8c…`. The devnet build has four instructions that are in no public klend commit, so no public source can match it |
| Squads Smart Account `SMRTzfY6…` | Solana devnet | `Squads-Protocol/smart-account-program` `0e51082` | **Fail:** devnet runs `e88ffe8d…`, deployed on 2 December 2025; `0e51082` (31 August 2026) builds to `1cacfe20…`, the hash Squads publishes for its mainnet build. Squads' own instructions say devnet runs a different executable |
| Safe 1.4.1: SafeL2, SafeProxyFactory, MultiSend, MultiSendCallOnly, CreateCall | Base Sepolia | `safe-global/safe-smart-account` tag `v1.4.1` | **Pass:** all five, runtime code equal byte for byte, and the init code gives the canonical address through the Safe singleton factory |
| Zodiac Roles v2.1.1 mastercopy, Integrity, Packer, MultiSend unwrapper | Base Sepolia | `gnosisguild/zodiac-modifier-roles` `218a5164` | **Pass:** all four, runtime code equal byte for byte, and the init code gives the recorded address through the ERC-2470 factory |
| Safe 1.5.0: SafeL2, SafeProxyFactory | Base Sepolia | `safe-deployments` v1.5.0 | Runtime keccak equals the `codeHash` Safe publishes (`180193…`, `967dae…`). This check compares published hashes only; the 1.5.0 source was not built here |

A failed match on devnet does not show the devnet programs are unsafe. It shows the source this repository reads is not the source of the devnet build, so a claim about devnet behaviour rests on what was run there, and a claim from the source holds for the build that source produces.

## Solana

Commands: [`build-hash-match/solana-check.sh`](build-hash-match/solana-check.sh); its output is [`build-hash-match/solana.log`](build-hash-match/solana.log). `solana-verify` 0.5.2 computes both sides: `get-program-hash` reads the ProgramData from devnet and drops the trailing zero padding, `get-executable-hash` does the same for a local `.so`. Each source was built in a clean worktree at the commit with `solana-verify build`, in Docker.

| | klend | Squads Smart Account |
|---|---|---|
| Program | `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD` | `SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG` |
| ProgramData (devnet) | `9uSbGW1y9H5Av6H5TKxQ1wnFApSq2t3oEpfF2YfjDQGA` | `2g3u9qgz4adKQVN1TUoh7bbBKqaSsjXtz1yX2ptagW5T` |
| Deploy slot, time | 491,561,420, 1 September 2026 17:19 UTC | 425,429,201, 2 December 2025 01:54 UTC |
| Upgrade authority (devnet) | `ELgAxEgaGCBxNcfLMqNSbBaYDWmHeirf6k439zrM2wmx` | `J496LGUhsKvBE6yRvet4FtMgxxox82fMiDKb3qtScUh2` |
| Devnet program hash | `4157037dbf1cae345f6aaee42edfb0b33cd919b4893cd129961ca08c5652679e` (4,296,560 bytes stored) | `e88ffe8d6f0a69bf94efbfd57404f54c713bf2ba744f438c9e096efe7b420ebd` (1,714,227 bytes stored) |
| Build image | the one `solana-verify` picks from the lockfile (Solana 1.17.18), as Kamino's CI runs it | `solana-verifiable-build@sha256:1388b6e4…` (Solana 1.18.16), the image Squads' README pins |
| Cited commit, its build | `e921c64`: `976f1c8c163ae34e0e13e524e0225b465bad2587b9e3bbc86e41b193ed401922` (2,474,424 bytes) | `0e51082`: `1cacfe2080faabf33a02ea285b6f8c8182358d3c6e40e3e7375ad0d7baa58cd4` |
| Check of the build method | `77e8185` (1.27.0) builds to `1a71bd2229fecb87daef1a4d7fda373bf17253af0c0bc2f19093aff881700702`, the hash OtterSec's registry holds for Kamino's verified mainnet build | `0e51082` gives the hash Squads publishes for its mainnet deploy at slot 443,245,754 (README on branch `docs/verified-build-alt-resolution`, `7e282a9`) |
| Other commits tried | none: no public commit has the devnet build's instruction set (below) | `6650c42`, the head of `main` when devnet was deployed: `e1d0ef7e3fb7db1872f240d175147668281780925a05979650ed0a082c46df5b`, no match |
| Devnet equals the cited build | **no** | **no** |

**Why no public klend commit matches devnet:** the devnet binary logs `Instruction: FreezeObligation`, `ThawObligation`, `AbortFreeze` and `ApproveFrozenObligationOwnershipTransfer`. No commit on any branch of the public klend repository, fetched on 27 October 2026, has a handler of those names (`git log --all -S freeze_obligation` is empty). Devnet runs a Kamino build of source that is not published.

**Why the Squads devnet build differs:** it was deployed nine months before `0e51082`. Squads' verification notes (the README on `docs/verified-build-alt-resolution`) say: "Devnet currently has a different executable and is not covered by this mainnet source/hash claim."

**What this changes:**

- The devnet runs cited in [docs/solana.md](../docs/solana.md), Prime's spikes and PayFi's line, ran on these devnet builds. What they show holds for the devnet builds as run; the source reading at `e921c64` and `0e51082` is a separate line of evidence for the builds those commits produce.
- PayFi's verifier pins both deploy slots. That still catches an upgrade. It does not tie either build to a source, and this check shows neither devnet build comes from the cited commit.
- klend's `has_debt` byte (2287) and the margin-call start (2336) are klend 1.26 layout facts from the source; on devnet they were confirmed by reading positions (`has_debt` 1 with debt, 0 without), which is what the line relies on.
- For mainnet the provenance is different, and this page did not read mainnet. OtterSec's verified-build registry (`verify.osec.io/status`, read 27 October 2026) lists Kamino's mainnet klend as a verified build of `77e8185` (1.27.0, verified 26 October 2026, hash `1a71bd22…`), and Squads publishes `0e51082` as its mainnet source with the hash reproduced above. A byte-for-byte match on the target network stays a mainnet prerequisite.

## EVM

Commands: [`build-hash-match/safe-check.cjs`](build-hash-match/safe-check.cjs) and [`build-hash-match/roles-check.cjs`](build-hash-match/roles-check.cjs); their output is [`build-hash-match/evm.log`](build-hash-match/evm.log). Both read Base Sepolia through `https://sepolia.base.org` (chain 84532).

Each contract passes three checks. The init code from the local build, put through `CREATE2` with the factory and salt the deployment used, gives the deployed address; since the address is the hash of the init code, an equal address means equal init code, metadata hash included. The runtime code read from Base Sepolia equals the runtime code of the local build. And the runtime keccak equals the hash the project publishes.

**Safe 1.4.1:** `safe-smart-account` at tag `v1.4.1` (`bf943f80`), `yarn install --frozen-lockfile` and `npx hardhat compile` under Node 20: solc 0.7.6, optimizer off, as the 1.4.1 changelog states. Factory: the Safe singleton factory `0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7`, salt 0. MultiSend's one immutable (its own address) is filled before the compare.

| Contract | Address | Runtime keccak, chain and build | Result |
|---|---|---|---|
| SafeL2 | `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` | `0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff` (24,421 bytes) | Pass |
| SafeProxyFactory | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` | `0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317` (3,054 bytes) | Pass |
| MultiSend | `0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526` | `0x0e4f7fc66550a322d1e7688e181b75e217e662a4f3f4d6a29b22bc61217c4b77` (629 bytes) | Pass |
| MultiSendCallOnly | `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` | `0xecd5bd14a08c5d2122379900b2f272bdf107a7e92423c10dd5fe3254386c9939` (410 bytes) | Pass |
| CreateCall | `0x9b35Af71d77eaf8d7e40252370304687390A1A52` | `0x2b3060c55fcb8275653e99ad511a71f67ba76934ed66a7d74d6e68b52afff889` (1,099 bytes) | Pass |

Each runtime keccak also equals the canonical `codeHash` in `safe-global/safe-deployments` v1.4.1 (`b45417dd`).

**Zodiac Roles v2.1.1:** `zodiac-modifier-roles` at `218a5164` (v2.1.1), `packages/evm`, `yarn install --frozen-lockfile` and the repository's own prebuild patch of `@gnosis.pm/zodiac`'s `SignatureChecker.sol`. `mastercopies.json` records each mastercopy's compiler input; every one of its sources (27 for Roles) equals the file at the commit, and solc 0.8.21 (optimizer on, 100 runs) on that input gives the recorded init code. Roles links Integrity and Packer at their recorded addresses. A library's runtime starts with its own address, which the EVM writes at deployment; the compare fills it the same way. Factory: ERC-2470 `0xce0042B868300000d44A59004Da54A005ffdcf9f`, salt 0.

| Contract | Address | Runtime keccak, chain and build | Result |
|---|---|---|---|
| Roles mastercopy | `0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5` | `0x471d8b3b419f1eb955230c0326c8812176df49bf3c7b414a563fda5a3c6c10b6` (24,409 bytes) | Pass |
| Integrity | `0x6a6Af4b16458Bc39817e4019fB02BD3b26d41049` | `0xee8ec55ea4ac609a3fc768eccf3f0479631454fe0a802e4a4b8132102d10d495` (5,637 bytes) | Pass |
| Packer | `0x869718C939652084BC491fBC5ce0D3C1d5B309F0` | `0xc28f5fb0c8857669286d01e3df89f310d5ddfbf98205ad46d2f7d28767a76c82` (2,138 bytes) | Pass |
| MultiSend unwrapper | `0x93B7fCbc63ED8a3a24B59e1C3e6649D50B7427c0` | `0x4d8d8608b70a6e2f40726b9dd74406bbf73e90cac58e23ee953e2b45ad7dc3df` (2,071 bytes) | Pass |

The recorded Roles init code was compiled with no libraries in the settings and linked afterwards. Compiling with the libraries in the settings, as the recorded input lists them, changes only the metadata hash; the check compiles the first way, which reproduces the recorded bytes.

**Not covered:** the Roles modules and Safes a Prime creates are ERC-1167 and Safe proxies of these mastercopies, made by each Prime's setup; OpenZeppelin's TimelockController 5.6.0 is deployed per gate by that setup and compiled from npm in the configuration check. Neither has a fixed deployment to compare, so a setup's verifier should check each proxy's implementation address.

## Reproducing

```bash
# Solana (Docker, solana-verify 0.5.2, Solana CLI); the log ran these four builds
KLEND_DIR=<klend checkout> SMRT_DIR=<smart-account-program checkout> \
  KLEND_COMMITS="e921c64 77e8185" SMRT_COMMITS="0e51082 6650c42" \
  evidence/build-hash-match/solana-check.sh
# the freeze instructions: in the devnet binary, in no public klend commit
solana program dump -u devnet KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD klend.so
grep -c 'Instruction: FreezeObligation' klend.so
git -C <klend checkout> fetch origin && git -C <klend checkout> log --all --oneline -S freeze_obligation

# EVM (Node 20): build Safe v1.4.1 with hardhat, install Roles 218a5164, then
SAFE_DIR=<safe-smart-account> SDEP_DIR=<safe-deployments> ETHERS=<ethers v5> \
  node evidence/build-hash-match/safe-check.cjs
ROLES_DIR=<zodiac-modifier-roles> SOLC=<solc 0.8.21> \
  node evidence/build-hash-match/roles-check.cjs
```
