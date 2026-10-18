// Writes ../requests.json: the shared vectors for prime-near-signer v2 (Grant and End accepted, every vote refused).
import { writeFileSync } from "fs";
import {
  SIGNER, NOW, hex, cat, utf8, wallets, walletId, walletSign, fmtTime, at, evmAddr, solKey, stellarC, stellarG, chains, grantText, endText, grantHash,
  sha256, ed25519, WalletName, ChainName, Addrs, TESTNET_ID, b58encode,
} from "./lib";

const OUT = process.argv[2] ?? "../requests.json";
const cases: any[] = [];
const refusals: any[] = [];

const schemeOf = (w: WalletName) => wallets[w].scheme.toLowerCase();
const pathOf = (w: WalletName, chain: ChainName, account: string) => `${schemeOf(w)}:${walletId(w)}/prime:${chains[chain].slug}:${account}`;

async function addCase(c: { id: string; shape: string; wallet: WalletName; request: any; text: string; path: string; domain: number; payload: Uint8Array; now?: number; extra?: any }) {
  cases.push({
    id: c.id, shape: c.shape, now: c.now ?? NOW, wallet: walletId(c.wallet), scheme: wallets[c.wallet].scheme, request: c.request,
    text: c.text, path: c.path, domain: c.domain, payload: hex(c.payload), signature: await walletSign(c.wallet, c.text), ...(c.extra ?? {}),
  });
}

function addrsFor(chain: ChainName, tag: string): Addrs {
  if (chain === "BaseSepolia") return { account: evmAddr("safe:" + tag), seat: evmAddr("seat:" + tag), key: evmAddr("key:" + tag) };
  if (chain === "SolanaDevnet") return { account: b58encode(solKey("settings:" + tag)), seat: b58encode(solKey("seat:" + tag)), key: b58encode(solKey("key:" + tag)) };
  return { account: stellarC("account:" + tag), seat: stellarC("seat:" + tag), key: stellarG("key:" + tag) };
}
async function grant(id: string, chain: ChainName, wallet: WalletName, now: number, startOff: number, len: number) {
  const a = addrsFor(chain, id), start = now + startOff, end = start + len;
  await addCase({
    id, shape: "Grant", wallet, now, request: { Grant: { chain, ...a, start, end } }, text: grantText(chain, a, start, end, schemeOf(wallet)),
    path: pathOf(wallet, chain, a.account), domain: chains[chain].domain, payload: grantHash(chain, a, start, end),
  });
}
async function end(id: string, chain: ChainName, wallet: WalletName) {
  const a = addrsFor(chain, id);
  await addCase({
    id, shape: "End", wallet, request: { End: { chain, ...a } }, text: endText(chain, a, schemeOf(wallet)), path: pathOf(wallet, chain, a.account),
    domain: chains[chain].domain, payload: grantHash(chain, a, 0, 0),
  });
}

async function main() {
  // Grants on three chains with calendar edges: leap days, the 2038 and 2100 boundaries, a year end with the maximum window and start offset
  await grant("grant-evm-votes", "BaseSepolia", "metamask", NOW, -120, 8 * 3600);
  await grant("grant-evm-leap-day", "BaseSepolia", "phantom", at("2028-02-29T12:00:00Z"), -120, 24 * 3600);
  await grant("grant-solana-votes", "SolanaDevnet", "freighter", NOW, -120, 8 * 3600);
  await grant("grant-solana-2038", "SolanaDevnet", "phantom", 2147483648 - 1800, -120, 7200);
  await grant("grant-stellar-votes", "StellarTestnet", "phantom", NOW, -120, 8 * 3600);
  await grant("grant-stellar-year-end-max-window", "StellarTestnet", "metamask", at("2026-12-31T23:59:00Z"), 300, 604800);
  await grant("grant-evm-2000-leap-day", "BaseSepolia", "freighter", at("2000-02-29T12:00:00Z"), -120, 3600);
  await grant("grant-evm-2100-no-leap", "BaseSepolia", "metamask", at("2100-02-28T23:00:00Z"), -120, 7 * 3600);
  { // A Phantom key that blind-signs the SEP-53 digest of a Sep53 grant text is accepted as Sep53, under a path no Raw seat uses
    const a = addrsFor("BaseSepolia", "cross-scheme"), start = NOW - 120, e = start + 3600, text = grantText("BaseSepolia", a, start, e, "sep53");
    cases.push({
      id: "cross-scheme-phantom-digest-as-sep53", shape: "Grant", now: NOW, wallet: walletId("phantom"), scheme: "Sep53", request: { Grant: { chain: "BaseSepolia", ...a, start, end: e } },
      text, path: `sep53:${walletId("phantom")}/prime:evm:${a.account}`, domain: 0, payload: hex(grantHash("BaseSepolia", a, start, e)),
      signature: hex(ed25519.sign(sha256(cat(utf8("Stellar Signed Message:\n"), utf8(text))), wallets.phantom.sk)), not_path: pathOf("phantom", "BaseSepolia", a.account),
    });
  }
  await end("end-evm", "BaseSepolia", "phantom");
  await end("end-solana", "SolanaDevnet", "metamask");
  await end("end-stellar", "StellarTestnet", "freighter");

  const good = (id: string) => structuredClone(cases.find((c) => c.id === id)!);
  const ref = (id: string, base: string, error: string, edit: (c: any) => void) => {
    const c = good(base);
    edit(c);
    for (const k of ["text", "payload", "path", "domain", "shape", "not_payload", "not_path"]) delete c[k];
    c.id = id; c.error = error;
    refusals.push(c);
  };
  const G = (c: any) => c.request.Grant;
  const upper = (s: string) => s.replace(/[a-f]/, (x) => x.toUpperCase());
  // Time rules (the accepted edges are cases: start 300 s ahead with a 604,800 s window)
  ref("grant-start-301s-ahead", "grant-evm-votes", "start", (c) => { const g = G(c), d = g.end - g.start; g.start = c.now + 301; g.end = g.start + d; });
  ref("grant-window-604801s", "grant-evm-votes", "window", (c) => { G(c).end = G(c).start + 604801; });
  ref("grant-end-equals-start", "grant-evm-votes", "window", (c) => { G(c).end = G(c).start; });
  ref("grant-end-before-start", "grant-evm-votes", "window", (c) => { G(c).end = G(c).start - 1; });
  // Canonical forms
  ref("grant-evm-checksummed-account", "grant-evm-votes", "address", (c) => { G(c).account = "0x" + upper(G(c).account.slice(2)); });
  ref("grant-evm-uppercase-0X", "grant-evm-votes", "address", (c) => { G(c).seat = "0X" + G(c).seat.slice(2); });
  ref("grant-evm-short-key", "grant-evm-votes", "address", (c) => { G(c).key = G(c).key.slice(0, 40); });
  ref("grant-solana-bad-base58", "grant-solana-votes", "address", (c) => { G(c).seat = G(c).seat.slice(0, -1) + "0"; });
  ref("grant-solana-31-byte-key", "grant-solana-votes", "address", (c) => { G(c).key = b58encode(solKey("k31").slice(0, 31)); });
  ref("grant-solana-33-byte-key", "grant-solana-votes", "address", (c) => { G(c).key = b58encode(cat(solKey("k33"), Uint8Array.of(7))); });
  ref("grant-stellar-lowercase-strkey", "grant-stellar-votes", "address", (c) => { G(c).account = G(c).account.toLowerCase(); });
  ref("grant-stellar-account-as-g", "grant-stellar-votes", "address", (c) => { G(c).account = stellarG("not-a-contract"); });
  ref("grant-stellar-key-as-c", "grant-stellar-votes", "address", (c) => { G(c).key = stellarC("not-a-key"); });
  ref("grant-stellar-bad-checksum", "grant-stellar-votes", "address", (c) => { const a = G(c).seat; G(c).seat = a.slice(0, -1) + (a.endsWith("A") ? "B" : "A"); });
  ref("grant-wrong-chain-address-form", "grant-solana-votes", "address", (c) => { G(c).chain = "BaseSepolia"; });
  ref("grant-unknown-chain", "grant-evm-votes", "chain", (c) => { G(c).chain = "BaseMainnet"; });
  ref("wallet-uppercase-hex", "grant-solana-votes", "wallet", (c) => { c.wallet = c.wallet.toUpperCase(); });
  ref("wallet-checksummed-evm", "grant-evm-votes", "wallet", (c) => { c.wallet = "0x" + upper(c.wallet.slice(2)); });
  ref("wallet-ed25519-under-eip191", "grant-solana-votes", "wallet", (c) => { c.scheme = "Eip191"; });
  // Signatures
  const flip = (h: string) => h.slice(0, -2) + (h.endsWith("00") ? "01" : "00");
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  ref("sig-ed25519-last-byte-flipped", "grant-solana-votes", "signature", (c) => { c.signature = flip(c.signature); });
  ref("sig-raw-first-byte-flipped", "grant-solana-2038", "signature", (c) => { c.signature = (c.signature.startsWith("00") ? "01" : "00") + c.signature.slice(2); });
  ref("sig-eip191-flipped", "grant-evm-votes", "signature", (c) => { c.signature = c.signature.slice(0, 10) + (c.signature[10] === "0" ? "1" : "0") + c.signature.slice(11); });
  ref("sig-eip191-high-s", "grant-evm-votes", "signature", (c) => {
    const g = c.signature, sv = BigInt("0x" + g.slice(64, 128)), v = g.slice(128);
    c.signature = g.slice(0, 64) + (N - sv).toString(16).padStart(64, "0") + (v === "1b" ? "1c" : "1b");
  });
  ref("sig-eip191-v-is-0", "grant-evm-votes", "signature", (c) => { c.signature = c.signature.slice(0, 128) + (c.signature.endsWith("1b") ? "00" : "01"); });
  ref("sig-eip191-64-bytes", "grant-evm-votes", "signature", (c) => { c.signature = c.signature.slice(0, 128); });
  ref("sig-ed25519-65-bytes", "grant-solana-votes", "signature", (c) => { c.signature += "1b"; });
  ref("sig-not-hex", "grant-solana-votes", "signature", (c) => { c.signature = "zz" + c.signature.slice(2); });
  ref("sig-by-another-wallet", "grant-solana-votes", "signature", (c) => { c.signature = cases.find((x) => x.id === "grant-stellar-votes")!.signature; });
  ref("sig-wrong-scheme-sep53-as-raw", "grant-solana-votes", "signature", (c) => { c.scheme = "Raw"; });
  ref("sig-wrong-scheme-raw-as-sep53", "grant-solana-2038", "signature", (c) => { c.scheme = "Sep53"; });
  {
    const a = addrsFor("BaseSepolia", "cross-scheme"), start = NOW - 120, e = start + 3600, text = grantText("BaseSepolia", a, start, e, "sep53");
    ref("sig-raw-over-sep53-text-as-raw", "grant-evm-votes", "signature", (c) => {
      c.wallet = walletId("phantom"); c.scheme = "Raw"; c.request = { Grant: { chain: "BaseSepolia", ...a, start, end: e } }; c.signature = hex(ed25519.sign(utf8(text), wallets.phantom.sk));
    });
  }
  ref("sig-field-changed-grant-end", "grant-evm-votes", "signature", (c) => { G(c).end += 1; });
  for (const [id, base, w] of [["sig-v1-text-freighter", "grant-solana-votes", "freighter"], ["sig-v1-text-phantom", "grant-solana-2038", "phantom"], ["sig-v1-text-metamask", "grant-evm-votes", "metamask"]] as const) {
    const b = good(base);
    const v1 = `Prime NEAR signer\ncontract: ${SIGNER}\npath: prime:${chains[b.request.Grant.chain as ChainName].slug}:${b.request.Grant.account}\ndomain: ${b.domain}\npayload: ${b.payload}`;
    const sig = await walletSign(w, v1);
    ref(id, base, "signature", (c) => { c.signature = sig; });
  }
  // The request shape: a scope field, an unknown shape, and every vote kind (refused before any signature check)
  ref("grant-with-scope-field", "grant-evm-votes", "field", (c) => { G(c).scope = "RulesOnly"; });
  ref("request-unknown-shape", "grant-evm-votes", "variant", (c) => { c.request = { Transfer: { to: G(c).account } }; });
  const sol = addrsFor("SolanaDevnet", "vote"), evm = addrsFor("BaseSepolia", "vote"), stl = addrsFor("StellarTestnet", "vote");
  const votes: Record<string, any> = {
    "vote-safe-eth-transfer": { SafeVote: { safe: evm.account, seat: evm.seat, to: evmAddr("payee"), value: "1000000000000000000", data: "0x", operation: "Call", nonce: 12 } },
    "vote-safe-delegatecall": { SafeVote: { safe: evm.account, seat: evm.seat, to: evmAddr("multisend"), value: "0", data: "0x8d80ff0a", operation: "DelegateCall", nonce: 7 } },
    "vote-squads-approve": { SolanaVote: { settings: sol.account, seat: sol.seat, consensus: sol.account, index: 12, valid_until: NOW + 900, instruction: { program: "SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG", accounts: [{ key: sol.account, signer: false, writable: false }], data: "0x886c665562720793" + "00" } } },
    "vote-squads-create-vault-transaction": { SolanaVote: { settings: sol.account, seat: sol.seat, consensus: sol.account, index: 26, valid_until: NOW + 900, instruction: { program: "SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG", accounts: [], data: "0xe3c135ef377e7069" } } },
    "vote-stellar-authorization": { StellarVote: { account: stl.account, seat: stl.seat, function: "add_signer" } },
  };
  for (const [id, request] of Object.entries(votes)) ref(id, "grant-evm-votes", "vote", (c) => { c.request = request; });

  const out = {
    version: 1, signer: SIGNER, now: NOW, scheme_note: "Sep53 = Freighter signMessage, Raw = Phantom signMessage, Eip191 = MetaMask personal_sign; signatures are hex without 0x",
    hash_notes: {
      evm_grant: "keccak256(abi.encode(keccak256('PrimeSeatGrant(uint256 chainId,address safe,address seat,address key,uint64 start,uint64 end)'), 84532, account, seat, key, start, end)); End = same with start 0 and end 0",
      solana_stellar_grant: "sha256('prime-seat-grant' || domain || account || seat || key || be64(start) || be64(end)); domain = ascii 'devnet' on Solana, sha256('Test SDF Network ; September 2015') on Stellar; keys are raw 32 bytes; End = same with start 0 and end 0",
      paths: "<scheme>:<wallet id>/prime:<evm|solana|stellar>:<account>; scheme is sep53, raw or eip191 (lowercase), so one ed25519 key used under two schemes derives two seat keys; domain 0 for evm (Ecdsa), 1 for solana and stellar (Eddsa); payload is the 32-byte hash as lowercase hex",
      texts: "every text ends with 'Signature scheme: <scheme>' and 'Signer: <v2 account>'; there is one session type, so a Grant carries no scope field",
      votes: "SafeVote, SolanaVote and StellarVote requests are refused with reason 'vote' (refusals 'vote-*')",
      stellar_network_id_hex: hex(TESTNET_ID),
    },
    cases, refusals,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
  console.log("cases", cases.length, "refusals", refusals.length, "->", OUT);
}
main();
