# Demo runbook

Commands for walking someone through the four gates on Stellar testnet. Every
command here was run against the live network before this page was written.

Build the binary once:

```bash
bun run prime:build     # produces ./prime, no runtime needed
```

Run it from the repo root as `./prime`. From anywhere else, set `PRIME_HOME` to
the repo root.

## Before the call

```bash
./prime up
```

Two minutes. It creates four keys, funds them, deploys the interpreter, Prime,
the adapter and the gatekeeper, approves a 20,000,000 limit, installs three
rules, supplies 2,000,000 into the live Blend pool, and raises the custody
thresholds. Keys land in `scripts/.env`, addresses in
`scripts/.demo-state.json`. Both are gitignored.

Check it came up:

```bash
./prime status
```

A deployment stays usable until the limit expires, about eight hours. Run `up`
again for a fresh one.

## 1. Open on the state

```bash
./prime status
```

One screen, four gates, each labelled with who owns it. Three are theirs.

Worth saying out loud while it is on screen:

- **Gate 3** reads `one key alone: cannot move value`. That is their treasury
  key being powerless on its own.
- **Gate 2** lists one address, the execution step. Not the venue — the venue
  is Gate 4's job.
- **Gate 4** shows rule 0 as `NO POLICY — unrestricted`. Say this before they
  find it. Section 5 below turns it into a strength.

## 2. Try to break it

```bash
./prime gates
```

Ten scenarios, about 25 seconds, each printing the state it depends on and
which layer refused. Or one gate at a time, which reads better on a call:

```bash
./prime gates g1     # spend past the limit; the limit's own expiry
./prime gates g2     # release to an address not on the list
./prime gates g3     # move money, weaken settings, close the account, one key
./prime gates g4     # exceed the mandate, break the amount tie, aim elsewhere
```

The line to point at is **which layer refused**. Gates 1 and 2 say "refused
while executing, by a contract you own". Gate 3 says "refused by
stellar-core". Only Gate 4 says "refused by our rulebook". Three independent
things say no, and two of them are theirs.

## 3. What one key can actually do

```bash
./prime rules list
./prime rules list --signer <G... the agent>
./prime rules list --signer <G... the admin>
```

The agent comes back **CONSTRAINED**: every rule it can name carries a policy.
The admin comes back **UNCONSTRAINED**, because it sits on rule 0.

Ask this when someone asks what the agent could do if it were compromised. A
key is only as constrained as the loosest rule it sits on, and the verdict is
computed from the rules on chain.

Get the two addresses from `./prime status --json`, or read them off the
`signer` lines in `./prime rules list`.

## 4. The move that is allowed

```bash
./prime exec withdraw              # permitted, nothing sent
./prime exec withdraw --submit     # lands it, prints the transaction
```

Submitted, it prints the hash, an explorer link, and the custody balance
afterwards. The balance moves by exactly the amount withdrawn.

`--submit` closes the position, so the two withdraw scenarios in `gates` will
then skip: a refusal with nothing to withdraw proves nothing. Put one back:

```bash
./prime demo run resupply
```

Supply works the same way:

```bash
./prime exec supply --amount 1500000            # permitted, nothing sent
./prime exec supply --amount 1500000 --submit   # lands it
```

## 5. The honest one

Three attempts, in this order:

```bash
./prime exec withdraw --to stranger
./prime exec withdraw --as admin
./prime exec withdraw --as admin --rule 0,2 --to stranger
```

The first is refused by the mandate. The second is refused because the admin
key is not a signer on that rule. **The third is permitted**, because rule 0
carries no policy and a caller chooses which rule authorises a call.

That third result is the exposure in
[custody-preserving-execution.md](custody-preserving-execution.md) §9.7, and
showing it is better than being asked about it. The fix is the same one the
document recommends: point rule 0 at a multi-signature account the client
controls, so that authority becomes M-of-N. None of these submit, so nothing
moves.

## Setting up someone else's gates

For a client who wants to see their own configuration go in:

```bash
./prime accounts setup --cosigner <G...> --dry-run
./prime gate setup --allow-list "<C...>,<C...>" --limit 5000000 --dry-run
./prime rules install supply --max-per-move 3000000 --venue <C...> --dry-run
./prime rules install withdraw --to <G...> --dry-run
```

Drop `--dry-run` to apply. A bad address is rejected before anything deploys.

## Every command

| Command | What it does |
|---|---|
| `./prime up` | build everything, one command |
| `./prime status [--json]` | all four gates, one screen |
| `./prime gates [g1..g4\|all]` | try to break them |
| `./prime accounts info [--json]` | Gate 3: thresholds and signers |
| `./prime accounts setup [--cosigner G...]` | apply the two-key thresholds |
| `./prime gate info [--json]` | Gates 1 and 2: limit, expiry, allow-list |
| `./prime gate setup --allow-list "..."` | deploy a gatekeeper and approve a limit |
| `./prime rules list [--signer G...]` | Gate 4: the mandate, or one key's reach |
| `./prime rules install supply\|withdraw\|venue` | install a mandate |
| `./prime rules remove --id N` | remove one (rule 0 is refused) |
| `./prime exec supply [--amount N]` | a supply through all four gates |
| `./prime exec withdraw [--to G...\|stranger]` | a withdrawal through all four gates |
| `./prime demo run resupply` | re-open a position |

Flags that work everywhere: `--dry-run` sends nothing, `--json` on read
commands, `--as agent\|admin\|custody\|cosign\|S...` picks the signer, `--rule
0,2` names which rules authorise a call, `--submit` lands a move and prints its
transaction hash.

## Timing

Every scenario in `gates` finishes in under five seconds, because no refusal
needs a ledger. Measured on testnet, the slowest was 3.7 seconds and the average
2.4. Three commands do submit and so wait for a ledger to close: `up` at about
two minutes, and `resupply` and `--submit` at roughly ten seconds each. Each
says so, and every step prints its own elapsed time.

## If something goes wrong

**`no scripts/.demo-state.json`** — run `./prime up`, or set `PRIME_HOME` to the
repo root if you are running the binary from elsewhere.

**A withdraw scenario SKIPS** — the position is closed, probably by a previous
`--submit`. Run `./prime demo run resupply`.

**Gate 1 refuses when you did not expect it** — the limit may be spent or
expired. `./prime gate info` shows what is left and how long it has.

**A step takes longer than usual** — testnet RPC latency varies. The numbers
printed are real; re-run the step.

**Nothing works and the call is in two minutes** — `./prime up` builds a
completely fresh deployment and does not depend on the old one.
