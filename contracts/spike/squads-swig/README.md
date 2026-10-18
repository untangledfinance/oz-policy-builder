# Squads v4 + Swig for Prime's 2-of-3 on Solana

Local validator with Squads v4 (`SQDS4ep6…`, code sha256 97fb2a5c…) and Swig (`swigypWH…`, c20de4cc…)
cloned byte-for-byte from devnet (devnet airdrop rate-limited). Member A = NEAR MPC ed25519 key requested
by MetaMask's eth-implicit account (native NEAR, NEP-518; no wallet contract, no NEAR-side code).

Finding: Squads cannot drive Swig admin. Swig rejects inbound CPI (SwigError::Cpi = 8, `check_top_level_or_signers`
with two hard-coded exempt keys), and its ProgramExec authority needs a preceding top-level instruction whose
first two accounts are the Swig config and wallet, which Squads' instructions never are (Q4d).

What works with no new code (40 checks, see *.txt):
- Squads 2-of-3 as rule 0: 1 approval cannot execute, non-members cannot approve, any 2 of 3 execute
  (A+B, D+B), member rotation (C -> D), removed member refused.
- Moves via Squads spending limits (SOL/SPL to allowed destinations, per period), installed by a 2-of-3
  config proposal; refusals InvalidDestination, SpendingLimitExceeded, Unauthorized.
- MetaMask sessions on top: the limit member is a Swig wallet W whose MetaMask session role may only
  call Squads; session key -> Swig W -> Squads spending_limit_use (outbound CPI is allowed).
