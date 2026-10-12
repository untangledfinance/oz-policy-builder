# PrimeSeat

`PrimeSeat` is the Safe owner for one NEAR-routed owner on one Prime Account on EVM. A Freighter or Phantom owner has no EVM wallet, so the owner signs through NEAR to start or end a session. While the session is live, a session key stands in for that owner on the Safe, beside a signature from a native owner (a Safe owner EOA such as MetaMask). Every Safe decision carries one native signature.

The contract is 66 formatted sLOC. Runtime code is 4,155 bytes and creation code 4,417 bytes (sha256 in [Build](#build)).

## Roles of the keys

| Key | Held by | Can |
|---|---|---|
| `owner` | the NEAR MPC key for `<wallet id>/prime:evm:<safe>` | sign a grant or an end. It never votes. |
| session key | the browser of the NEAR-routed owner | vote beside a native signature, call `exec`, end itself |
| native owner | an EOA that the Safe lists as an owner | its signature over the Safe transaction hash makes a seat proof count |

## Interface

```solidity
constructor(address owner, address safe, IRoles roles)          // all three immutable

function grant(address key, uint64 start, uint64 end, bytes sig)
function exec(address to, uint256 value, bytes data, uint8 op, bytes32 role, address key, bytes sig)
function isValidSignature(bytes32 h, bytes sig) returns (bytes4)   // Safe 1.5.0
function isValidSignature(bytes data, bytes sig) returns (bytes4)  // Safe 1.4.1
function sessions(address key) returns (uint64 start, uint64 end, uint128 nonce)
```

### grant

The signed hash is `keccak256(abi.encode(GRANT_TYPEHASH, chainid, safe, seat, key, start, end))` with

```
GRANT_TYPEHASH = keccak256("PrimeSeatGrant(uint256 chainId,address safe,address seat,address key,uint64 start,uint64 end)")
```

- `end != 0`: the `owner` signs. The grant needs `start <= now <= end`, `end - start <= 7 days` and `end` later than the stored end. A grant replaces the stored start and end and keeps the nonce.
- `end == 0`: an end. The `owner` or the key itself signs the hash with `start` and `end` both 0, and the key is finished for good. A later grant for it fails, including a grant signed before the end and filed after it.
- A session uses one storage slot: `uint64 start`, `uint64 end`, `uint128 nonce`. An ended key stores `end = type(uint64).max`.
- Use checks the stored values again: `start <= now <= end` and `end - start <= 7 days`. An ended key fails the second test.

The shared vectors in `contracts/prime/near/vectors/requests.json` carry the hash for `grant-evm-votes` and `end-evm`. `PrimeSeat.t.sol` checks both.

### exec

A live session key signs `keccak256(abi.encode(seat, chainid, nonce, to, value, keccak256(data), op, role))`. The seat then calls `roles.execTransactionWithRole(to, value, data, op, role, true)`. The nonce goes up by one on each call. `exec` refuses `to` equal to the Safe, the Roles module or the seat, and any `op` other than 0. Use it for Roles rules that list the seat.

### Votes

Safe calls `isValidSignature` on a contract owner, and only the Safe may ask. Safe 1.4.1 calls the `bytes` form (`0x20c13b0b`) with `data = 0x1901 | domain separator | SafeTx hash`. Safe 1.5.0 calls the `bytes32` form (`0x1626ba7e`) with the hash. The `bytes` form needs 66 bytes of data that start with `0x1901`, and then asks the `bytes32` form about `keccak256(data)`.

The `sig` for hash `h` is 130 bytes:

1. 65 bytes: a live session key's signature over `keccak256(abi.encode(seat, h))`.
2. 65 bytes: a Safe owner's signature over `h`.

The seat returns the success value only when both parts hold. Naming the seat in the first part keeps one key that sits on two seats from voting through a proof made for the other. The second part makes the native owner's approval of exactly this transaction part of every seat vote. A seat holds no private key, so `ecrecover` never yields a seat address.

A malformed signature (wrong length, bad `v`, high `s`) reverts as OpenZeppelin `recover` does. Every other refusal returns `0xffffffff`.

## What the Safe needs

- Create the Safe with the native owner as its only owner. Nonce 0, signed by that owner alone, deploys the seats from the Safe with CreateCall (so each address follows from the Safe address), adds them as owners with the final threshold, deploys and enables Roles, and installs the rules that list the seats.
- Every account needs at least one native owner. Two NEAR-routed owners cannot move the account alone.
- A Roles rule that lists a seat lets the session act alone inside the rule. Rules must not reach the Safe, Roles or the seat; `exec` enforces that, and the app refuses and flags such rules.

## Tests

```sh
npm pack @openzeppelin/contracts@5.4.0
tar xzf openzeppelin-contracts-5.4.0.tgz
mkdir -p lib/oz && cp -r package/utils package/interfaces lib/oz/   # lib/ stays out of git

forge fmt --check src
forge test                                  # unit suite, no network
FORK_URL=<Base Sepolia RPC> forge test      # adds the real Safe 1.4.1 and 1.5.0 tests
```

- `test/PrimeSeat.t.sol`: 45 unit tests against stub Safe and Roles contracts. Each rule in this file has a test, including a grant preimage passed as `data`, an end that arrives after a held-back grant, and window and start checks on stored states a grant cannot create.
- `test/PrimeSeatSafe.t.sol`: the seat as a contract owner of a real Safe 1.4.1 L2 and a real Safe 1.5.0 L2 (a fork of Base Sepolia), with nonce 0 through MultiSend. It covers the accepted and refused vote shapes on both versions, and a migration of a Safe 1.4.1 to 1.5.0 by an M-of-N vote through the official `SafeMigration`, followed by votes in the 1.5.0 form.
- `mutate.py`: the mutation pass (117 mutants). `FORK_URL=<rpc> ./mutate.py out.json` edits one spot at a time and runs the whole suite. 114 mutants die. The three that survive have no effect on behaviour: two change the `op` argument that `exec` already requires to be 0, and one changes the text of a revert reason.

## Build

Foundry 1.8.4, Solidity 0.8.28, optimizer 200 runs, `via_ir` off. The contract imports one OpenZeppelin Contracts 5.4.0 file (`ECDSA`).

| Artifact | Bytes | sha256 |
|---|---|---|
| runtime code | 4,155 | `df99988b727e7b904de0eedab4da01b6ca8abf315f99330611aebad7776b3b7e` |
| creation code | 4,417 | `f53336b63e3804f6c4deb66eed943722bc72db712af783007802821a05e3f6d4` |

The hashes are of the bytes in `out/PrimeSeat.sol/PrimeSeat.json` from `forge build`.

## Gas

Receipts on a fork of Base Sepolia, 5 runs of each operation, median and maximum, on a 2-of-3 account (one native owner, two seats). The first run of an operation can cost more than the next ones. The raw files are in `bench/02/` of the NEAR integration folder.

| Operation | Safe 1.4.1 median | max | Safe 1.5.0 median | max |
|---|---|---|---|---|
| Deploy a seat (plain CREATE) | 953,101 | 953,101 | 953,089 | 953,089 |
| `grant` (start a session) | 51,182 | 51,182 | 51,182 | 51,182 |
| End signed by the owner | 33,499 | 33,499 | 33,499 | 33,499 |
| End signed by the key | 33,591 | 33,591 | 33,591 | 33,591 |
| Vote: native owner plus one session | 100,141 | 100,153 | 98,316 | 98,328 |
| Vote: two sessions, native copy in each | 120,741 | 120,765 | 117,710 | 117,710 |
| Vote: two native owners (plain-key Safe) | 81,515 | 98,615 | 80,945 | 98,057 |
| `exec` move through Roles | 125,123 | 125,123 | 127,444 | 127,444 |

Nonce 0 with two seats, one native owner and a spending rule costs 2,654,834 gas on Safe 1.4.1 (median of 3). The same nonce 0 with three native owners and no seats costs 750,047.
