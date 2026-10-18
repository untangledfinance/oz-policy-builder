# Swig on Solana, laid out like a Prime Account — and a NEAR-owned Swig role

Ran on a local validator with the **Swig program cloned byte-for-byte from devnet**
(`swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB`, code sha256 c20de4cc…, identical on both): the devnet
airdrop was rate-limited, the alternative RPCs need keys, and the PoW faucet needs a starting balance.
The NEAR part (N1–N6) used real NEAR testnet. `SOL_RPC=<devnet> bun swig.ts setup|mm|expiry|phantom|near`
reruns everything on devnet once the payer holds ~0.3 devnet SOL.

Layout: role 0 root = owner's Phantom key (all); session roles for MetaMask (secp256k1), Phantom and a
NEAR MPC key, each limited to "SOL to VENUE, 0.05 total, sessions <= 300 slots"; plain mover role for key B.

29/29 checks passed (`state-local.json`, `near-run.txt`). Error codes: 3005 PermissionDenied,
3006 PermissionDeniedMissingPermission, 3010 PermissionDeniedToManageAuthority, 3014
PermissionDeniedSessionExpired, 3022 InvalidSessionDuration, 3029 PermissionDeniedSolDestinationLimitExceeded.

Not native in Swig: k-of-n approval (2-of-3 rule 0). Every role acts alone.
