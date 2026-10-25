# Prime architecture

Untangled Prime lets an agent put part of a treasury to work while the funds
stay in the institution's own custody and can reach only the destinations the
institution listed. It runs on Stellar, EVM and Solana. This page covers the
whole system; each chain has its own page for the contracts and the numbers,
and [audit-overview.md](audit-overview.md) gives the audit scope, which covers
the Stellar contracts.

| Chain | Prime account | Our contracts | Where it runs |
|---|---|---|---|
| Stellar | OpenZeppelin smart account | policy interpreter, custody gate, execution adapter, Prime seat | Stellar testnet |
| EVM | Safe with Zodiac Roles | `PrimeSeat` | Base Sepolia fork tests; no persistent deployment |
| Solana | Squads Smart Account | custody gate, `prime-seat` | Solana devnet |

Detail: [stellar.md](stellar.md), [evm.md](evm.md), [solana.md](solana.md).

## The use case

An institution holds its treasury in an MPC wallet, such as a Fordefi vault. It
wants an agent to put part of it to work: swap it, supply it to a lending pool,
withdraw it again. It wants the treasury to stay where it is, with no way for
anyone, us included, to take it somewhere it did not agree to.

The setup gives two guarantees:

1. **The MPC wallet always controls the funds:** the money stays in custody.
   Nothing moves unless custody's own signers approved the limit it moves
   under, and they can stop it at any time.
2. **Only the destinations on the custody gate's list can receive funds:**
   custody grants its limit to a gate. The gate holds a list of the places money
   may go, and it refuses everything else.

## The setup

### Step 1: set up

The MPC wallet needs all of its signers to move anything. In the setup we
tested, key A (the MPC key) carries weight 10, key B weight 5 and a trusted
third party weight 5, against a threshold of 20. Any two keys reach 15 at most,
so no pair can act without the third.

The wallet approves one thing: a limit for its custody gate. The gate carries
the list of addresses the funds may go to. The Prime account is a separate
account with three signers, any two of which can approve. It holds no funds. The
mandate, meaning what the agent may do, how much per move and at which venue,
is installed on the Prime account as rules.

```mermaid
flowchart LR
    A["Key A<br/>the MPC key<br/>weight 10"] --> MPC
    B["Key B<br/>weight 5"] --> MPC
    T["Trusted third party<br/>weight 5"] --> MPC
    MPC["MPC wallet<br/>holds the funds<br/>threshold 20"]
    MPC -->|"approves a limit:<br/>amount, expiry,<br/>allowed destinations"| GATE["Custody gate"]
    A2["Key A"] --> PRIME
    C["Key C"] --> PRIME
    PRIME["Prime account<br/>2 of 3 signers<br/>holds no funds"]
    PRIME --- MANDATE["Rules<br/>what the agent may do"]
```

### Step 2: execution

A move is one transaction. The agent prepares a batch of calls that moves funds
from custody to a venue. The Prime account checks the batch against its rules.
Small moves need the agent alone; larger ones need a second Prime signer, key C
in the diagram, before they run. The gate draws the funds from custody within
the limit, the venue receives them, and whatever comes back goes to custody. If
any call in the batch fails, the whole transaction reverses.

A move can also wait. On Stellar the execution adapter stores the batch,
anyone can run it once the wait is over, and custody or the Prime account can
cancel it until then. The stored batch runs under a rule with no signer, bound
to the adapter, whose predicate permits the adapter's `run` alone, so running
it needs no key. On Solana the Squads rule's time lock stores the whole batch.
On EVM, moves run at once and recovery waits on a timelock.

```mermaid
flowchart LR
    A["Agent<br/>1. prepares the batch"] --> PRIME
    C["Key C<br/>2. co-signs a large move"] -.-> PRIME
    PRIME["Prime account<br/>checks the rules"] --> GATE
    MPC["Custody"] -->|"funds drawn<br/>within the limit"| GATE["Custody gate<br/>only listed destinations"]
    GATE --> VENUE["Venue<br/>lending pool or exchange"]
    VENUE -->|"proceeds and withdrawals"| BACK["Back to custody"]
```

### Step 3: recovery

If custody's signers lose access, the funds still need a way out that does not
depend on them. A recovery address, such as a wallet held by the trusted third
party, is fixed when the gate is created. The Prime account's own signers at
their threshold can then move custody's funds to that address, and only to
that address. An agent's rules cannot reach it.

```mermaid
flowchart LR
    MPC["Custody"] --> GATE["Custody gate"]
    PRIME["Prime account<br/>owners at their threshold"] -->|"asks for a recovery"| GATE
    GATE -->|"only to the recovery address"| REC["Recovery wallet<br/>trusted third party"]
```

## How each chain keeps the two guarantees

| | Stellar | EVM | Solana |
|---|---|---|---|
| Custody | A classic Stellar account; the weights and threshold are enforced by the network | A Fordefi address; the rule that all signers approve lives in the Fordefi policy, because EVM cannot put weights on an address | An SPL Token multisig of custody and a trustee, which hands the owner and close authority of a dedicated token account to the gate |
| What custody approves | A token allowance to the gate, per asset, with an amount and an expiry of up to 180 days | A token approval to the gate, per asset; the amount is the gate's total budget | The hand-over, then a cap the gate sets as the token account's delegated amount |
| The custody gate | Our contract, deployed by custody; no admin, no settings | A Safe that custody alone owns, with Zodiac Roles rules naming the only venues and addresses | Our program; owns the token account and pays only listed destinations |
| Where results go | Straight to custody; a Blend position is held in the Prime account's name, and every withdrawal is pinned to custody | Every result, the lending position included, goes to custody | The venue pays proceeds into a gate-owned custody account |
| Per-move limits | Amount bands in policy-interpreter predicates | Roles bands, a daily cap for the agent and a daily cap on everything leaving custody | Squads policies |
| Stopping it | Custody sets the allowance to zero or lets it expire, and can cancel any stored move | Custody turns off the gate's trading rules; recovery keeps working unless custody stops that too | Any one custody signer lowers the cap to 0 |
| Recovery | The Prime owners pull to the recovery address; the pull waits the adapter's minimum wait, and custody or the Prime account can cancel it until it runs | The Prime owners schedule it on an OpenZeppelin timelock; custody can cancel during the delay | The Prime owners pay the recovery address at any time with no cap; the only wait is the Prime account's own time lock |

## Components

```mermaid
flowchart TB
  subgraph W["Owners' keys"]
    FR["Stellar wallet<br/>a native owner"]
    MM["EVM wallet<br/>a native owner"]
    PH["Solana wallet<br/>a native owner"]
    OK["Seat owner keys<br/>MPC or raw signer"]
  end
  subgraph XLM["Stellar"]
    OZ["OZ smart account<br/>rule 0 + policed rules"]
    SS["Prime seat"]
    INT["policy interpreter"]
    AD["execution adapter"]
    G1["custody gate"]
  end
  subgraph EVM["EVM"]
    SAFE["Safe + Zodiac Roles"]
    PS["PrimeSeat"]
  end
  subgraph SOL["Solana"]
    SQ["Squads Smart Account"]
    SP["prime-seat"]
    G2["custody gate"]
  end
  FR == "own signature" ==> OZ
  MM == "own signature" ==> SAFE
  PH == "own signature" ==> SQ
  OK -. "signs a grant" .-> SS & PS & SP
  SS --> OZ
  PS --> SAFE
  SP --> SQ
  OZ --> INT
  OZ --> AD --> G1
  SQ --> G2
```

| Component | Chain | Trusted for | Written by |
|---|---|---|---|
| Custody wallet and its signers | each | holding the funds and approving the limit | the institution (Fordefi or another MPC) |
| Custody gate | Stellar, Solana | paying only listed destinations within the limit | us |
| Custody gate | EVM | the same, as a Safe owned by custody with Roles rules | Safe, Zodiac (audited code, unmodified) |
| Execution adapter | Stellar | running a batch atomically; bound to a gate, naming only addresses the gate lists; with no gate, refusing a call to the Prime, any wait and any grant other than its word to the Prime's policy | us |
| Policy interpreter | Stellar | evaluating a rule's predicate on every call the rule authorises, and holding a rule with no signer to its executor binding | us |
| Prime account | each | counting owners' approvals and selecting rules | OpenZeppelin, Safe, Squads |
| Prime seat | each | letting a session key stand in for one owner on one account | us |
| A seat's owner key | each | signing only the grants and ends its holder means | the holder: a NEAR-routed MPC in the reference integration, or any signer that raw-signs the grant hash |
| Policy builder | Stellar | writing rules and returning them unsigned for the owners' wallets | us, in this repository |
| Prime apps and relayer | off chain | building transactions and paying fees; they hold no authority over funds | us, in a separate repository |

## Trust boundaries

| Party | Can | Cannot |
|---|---|---|
| Custody's signers at their threshold | grant, lower and revoke the limit; cancel stored moves (Stellar) and recoveries (Stellar, EVM); release the token account back (Solana) | move funds past the gate without the Prime account; change a gate's list (a new gate is needed) |
| One custody signer | lower the cap to 0 on Solana | raise a limit or move funds |
| The Prime owners at their threshold | install and remove rules, add and remove owners, recover to the recovery address; on Stellar and Solana, also draw within the limit to any address on the gate's list | pay an address the gate does not list; exceed custody's limit (except Solana recovery, which has no cap) |
| The agent | move funds inside the rules that list it | act outside a rule, recover, cancel (Stellar), change a rule |
| Anyone | run a stored Stellar batch once its wait is over and before its window closes; run an immediate Stellar batch through a no-gate adapter when the Prime's keyless rules bound to that adapter permit it (a liquidation) | change what the batch does, or run it twice; pass a keyless rule with a batch its predicate does not permit |
| A session key | vote for its seat's owner beside a native owner, and act alone inside rules that list its seat, until its end or the owner's end | act on an account whose owners never listed its seat (on Stellar and EVM the seat is bound to one account on chain; on Solana another account can list the seat, and onboarding refuses that); on Solana, create a transaction |
| The holder of a seat's owner key | grant and end sessions for that seat | act for any other owner or seat |
| The Prime apps and the relayer | submit and pay for transactions, hold session keys in the browser | forge an owner's grant, a native signature or a custody signature. On Solana `prime-seat` passes the transaction's outer signers into the Squads call, so the relayer refuses any transaction that lists its own key except as fee payer or, for an end, rent payer |
| Us, the builders | run the tooling, the agent and the apps; deploy new code | change a deployed gate, adapter, interpreter, seat or Solana program: none has an admin or an upgrade path |

The most money at risk at any moment is the limit custody granted, plus anything
supplied to a venue. On Solana the Prime owners at their threshold also reach
the whole gate-owned balance, but only toward the fixed recovery address.

## Owners, Prime seats and session keys

Each owner of a Prime account holds one vote, and casts it in one of two ways.

- **A native owner** signs on the account's chain with its own key: a Stellar
  account, an EVM wallet such as MetaMask, or a Solana wallet such as Phantom.
  On the account it is a plain signer of rule 0, a Safe owner or a Squads
  settings signer, and it signs every decision itself.
- **A seat owner** signs with an owner key: an ed25519 key on Stellar and
  Solana, a secp256k1 key on EVM. Its holder must produce a raw signature over
  the 32-byte grant hash. In the reference integration a NEAR-routed MPC, an
  external custodian outside this repository, holds the key; any signer that can
  raw-sign that hash, such as another MPC, a server-held keypair or a custody
  service configured for raw signing, can serve. Interactive wallets that sign
  only transactions or prefixed messages produce signatures the seat refuses, so
  a browser wallet cannot hold an owner key: an owner whose wallet lives on
  another chain becomes a seat owner through a custodian that holds the key.
  On the account the owner has a Prime seat: a contract (Stellar, EVM) or a
  program address (Solana) that is the signer in its place. Each seat checks
  one signature format.

The owner key signs one grant that names the account, the seat, a session key
and a start and end at most 7 days apart. Until the end, the session key votes
for the owner and acts inside the rules that list the seat, with no further
prompt to the owner key. A native owner has no session key.

Every decision needs one native owner, on every chain:

| Chain | How the seat is held back |
|---|---|
| Stellar | In the Prime app's rule-0 layout rule 0 carries a weighted threshold: each native account weighs K, each seat 1, and K is the number of seats at creation plus one, so seats alone stay below the threshold (a seat added later sits at weight 0). The seat serves rule 0 only through `External` and other rules only through `Delegated`, so one session cannot pass rule 0 alone through a duplicate entry |
| EVM | A seat's signature for the Safe holds two parts: the session key's and a Safe owner's own signature over the same transaction hash. A seat vote passes only with the native owner's approval of exactly that transaction |
| Solana | A seat cannot create a transaction (no Initiate, and `prime-seat` refuses the call), so a native owner writes every change and the seats approve |

Some checks that keep one key from counting twice live in the apps: the owner
keys must differ, no seat may sit in two accounts, no plain key may sit beside
its own seat, and on Solana only the canonical seat PDA is accepted. No
contract enforces the first and the third. The second holds on chain on
Stellar and EVM, because a seat is bound to one account at construction, and
only through onboarding on Solana.

### Starting a session

```mermaid
sequenceDiagram
  participant O as Owner key
  participant A as Prime app
  participant S as Seat
  A->>A: make a fresh session key
  A->>O: grant hash: account, seat, key, start, end
  O-->>A: raw signature over the grant hash
  A->>S: grant (Stellar, EVM: stored on chain)<br/>or carried in every call (Solana)
  S->>S: check times, freshness and the signature
```

### A decision with a seat

```mermaid
sequenceDiagram
  participant N as Native owner
  participant K as Session key
  participant S as Seat
  participant P as Prime account
  N->>P: writes the transaction and signs it
  K->>S: signs the same decision as the seat
  S->>S: grant live? key not ended?<br/>EVM: native signature inside?
  S-->>P: seat approval
  P->>P: threshold reached with at least one native owner
```

### Ending a session

The session ends at its end time, when the owner key or the session key itself
signs an end, or when the owners remove the seat. On Stellar an end stores 0
for the key, which refuses every later grant for it until that entry expires
from temporary storage, about 180 days on; after that only a grant the owner
signs can bring the key back. The EVM seat stores the maximum end, and the
Solana program takes over a marker account at `[owner, settings, key]`, so on
those chains an ended key never returns. Removing an owner of any kind must
always be possible; the apps rewrite or switch off rules that would block it.

## Why it is built this way

**Custody stays put and the gate has no admin:** the institution keeps its
existing custody and approvals; Prime adds a limit and a list. The gates have
no admin, no setters and no upgrade path, so changing the list means a new gate
and a new approval by custody's full threshold. On Stellar the gate also pins
the build of the one adapter that may call it, because a Soroban contract id
commits only to the deployer and salt.

**Our own contracts on Stellar:** Soroban allows one host-function call per
transaction, so a batch needs a contract that makes several calls atomically
(the execution adapter). The OpenZeppelin account checks each authorised call
against a rule, and the policy interpreter turns a rule into data: a new
mandate is a new predicate, with no new contract and no new audit. The same
adapter, created with no gate, lets a Prime bundle its own calls, such as a
check followed by transfers that happen only if the check passes. It then
checks no address, so the Prime's own rules are the only limit, and it runs
every batch at once ([stellar.md](stellar.md#no-gate)).

**A stored batch runs with no key:** whoever runs a stored batch only chooses
when, because the Prime approved the batch whole when it was stored. The rule
that answers the adapter's `run` therefore lists no signer. The interpreter
accepts it only while it is bound to the adapter, has the interpreter as its
only policy and pins `call_fn == run`, and it takes the adapter's own `run`
context as the adapter's consent. Every other context under a bound rule needs
a grant from the adapter. A rule signed by the adapter would do the same job,
and OpenZeppelin's 0.8.0 account refuses it (a delegated signer that is also a
contract called in the operation, error 3017).

**EVM uses only audited code for custody:** Safe, Zodiac Roles and
OpenZeppelin's TimelockController express the gate, the bands and the recovery
delay without a contract of ours. The seat is the one exception, 72 lines.

**Solana's gate owns the token account:** custody hands the owner and the
close authority of one token account to the gate. Recovery then reaches the
whole balance with no cap, and any one custody signer can stop the agent by
lowering the cap. The alternative, an SPL multisig owning the account and
approving the gate as delegate, was spiked (162 of 162 checks) and set aside:
its recovery stops at the remaining allowance and an SPL account has one
delegate. Swig was tested as a session layer and set aside too: its 7-day cap
counts slots, it allows one live session per role, and its upgradeable program
did not match a verified build.

**One signature format for seats:** each seat checks one format over a 32-byte
hash, the one its chain verifies natively: ed25519 on Stellar and Solana (on
Solana through the built-in ed25519 program), ECDSA on EVM. No seat needs other
cryptography. The owner key can live in whichever custodian signs that
format.

**Session keys hold a vote, with a native owner beside them:** a session that
holds an owner's vote can do anything that owner's vote can, so the rule-0
layout keeps every decision behind one native signature, the grant names its
account and seat, and a seat is bound to its account on chain.

**Final programs, fresh rule ids:** the Solana programs deploy with `--final`,
so behaviour changes only with a new deployment and a new pin. On Stellar a
rule is never edited in place: the interpreter pins the rule's signers, so
replacing a rule is the safe way to change who signs it.

## Known behaviours

- **A policed rule stops working when its signers change:** the interpreter
  stores a hash of the rule's signers and refuses every signer (error 204) once
  the set changes. Remove a signer by adding a new rule without it and removing
  the old one.
- **`remove_context_rule` can leave an interpreter entry behind:** the
  interpreter's `uninstall` needs the policy admins' own authorisation; when it
  fails, the account removes the rule anyway, and the entry stays until it
  archives. Nothing reads it again.
- **`uninstall` drops an executor binding:** it needs only the policy admins. A
  rule with no signer then refuses every call (error 206 with no document, 210
  once one is installed again); a keyed rule installed again has no binding
  until the owners bind it again.
- **Seats join policed rules as `Delegated`:** the interpreter refuses
  `External` signers (error 212), `Default` scope and rules scoped to the
  account or to the interpreter (error 218).
- **An adapter with no gate checks no address:** a batch through it can do what
  the Prime's rules allow for each call that asks the Prime, and move anything
  the adapter holds. It must never hold funds or an allowance. In an immediate
  `execute` it hands out one grant, its word to the Prime's policy, so a rule
  bound to it passes for the calls the batch names. A keyless rule scoped to it
  must pin the whole batch shape (221), and the predicates of the rules bound
  to it are the only fence ([stellar.md](stellar.md#no-gate)). A keyed rule scoped to it must hold the
  grants to none (STRIDE E-36); a dedicated no-gate adapter for keyless rules
  avoids the hazard. A bundle that failed can be submitted again by whoever
  holds its signed address-credential entry, until that entry's expiry ledger.
- **A seat cannot be a policy admin:** admins authorise by `require_auth`,
  which a seat satisfies only inside its own account's check.
- **Owner counts per chain:** Safe and Roles have no cap (12 owners measured in
  one setup transaction); Squads fits 25 signers in a create transaction and
  reached 62 signers one add at a time; an OpenZeppelin account takes 15
  signers in rule 0 and refuses 16 (October 2026 test runs).
- **The last owner:** a Safe refuses to remove its only owner (`GS013`) and
  Squads refuses the matching proposal (`NoProposers`). An OpenZeppelin account
  accepts removing its only rule-0 signer and is then unreachable, so the app
  must refuse that step.
- **An owner key's custodian can grant sessions:** whoever controls a seat's
  owner key can start a session for that seat on any chain, so the key's
  custody is part of the trust in the seat.

**Notes for rule writers:**

- On EVM and Solana, bytes after the last checked argument pass the rule, and
  the venue reads the same call; pin targets that decode with a standard
  decoder.
- Solana policies read call data at fixed offsets, so a field after a
  variable-length field cannot be checked.
- Stellar amounts are signed integers, so an upper bound alone lets a negative
  amount through; give every amount a lower bound.
- A Stellar call that authorises two contexts (a Blend `submit` and its token
  `transfer`) needs a rule for each, because the interpreter sees one authorised
  call at a time.
