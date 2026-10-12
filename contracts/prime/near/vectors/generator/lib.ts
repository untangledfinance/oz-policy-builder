// Shared helpers for the v2 vector generator: test wallets, canonical encodings, text templates.
// Expected values come from viem, @stellar/stellar-sdk, @solana/web3.js, @sqds/smart-account and @noble, not from the Rust code.
import { keccak256, toBytes, toHex, encodeAbiParameters, parseAbiParameters, hashTypedData, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { StrKey, Networks, hash as stellarHash } from "@stellar/stellar-sdk";
import { PublicKey } from "@solana/web3.js";

export const SIGNER = "seats.prime-spike-muwguc60.testnet";
export const NOW = 1791799200; // 2026-10-12 10:00:00 UTC
export const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export const u8 = (h: string) => new Uint8Array(Buffer.from(h.replace(/^0x/, ""), "hex"));
export const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
export const be8 = (n: bigint | number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; };
export const be16 = (n: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n); return b; };
export const be32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
export const le64 = (n: bigint | number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
export const utf8 = (s: string) => new TextEncoder().encode(s);
export const seed = (label: string) => sha256(utf8(label));

// Test wallets: deterministic throwaway keys, never funded, never used outside these vectors.
export const wallets = {
  freighter: { scheme: "Sep53", sk: seed("prime-vector-freighter") },
  phantom: { scheme: "Raw", sk: seed("prime-vector-phantom") },
  metamask: { scheme: "Eip191", sk: seed("prime-vector-metamask") },
} as const;
export type WalletName = keyof typeof wallets;
export function walletId(w: WalletName): string {
  if (w === "metamask") return privateKeyToAccount(toHex(wallets.metamask.sk)).address.toLowerCase();
  return hex(ed25519.getPublicKey(wallets[w].sk));
}
export async function walletSign(w: WalletName, text: string): Promise<string> {
  const m = utf8(text);
  if (w === "phantom") return hex(ed25519.sign(m, wallets.phantom.sk));
  if (w === "freighter") return hex(ed25519.sign(sha256(cat(utf8("Stellar Signed Message:\n"), m)), wallets.freighter.sk));
  const sig = await privateKeyToAccount(toHex(wallets.metamask.sk)).signMessage({ message: text });
  return sig.slice(2);
}

// Dates
export function fmtTime(t: number): string {
  const d = new Date(t * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC (${t})`;
}
export const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// Labels to addresses
export const evmAddr = (label: string) => ("0x" + hex(keccak256(utf8(label), "bytes").slice(12))) as string;
export const solKey = (label: string) => seed("sol:" + label);
export const stellarC = (label: string) => StrKey.encodeContract(Buffer.from(seed("stellar-c:" + label)));
export const stellarG = (label: string) => StrKey.encodeEd25519PublicKey(Buffer.from(ed25519.getPublicKey(seed("stellar-g:" + label))));

export const TESTNET_ID = stellarHash(Buffer.from(Networks.TESTNET)); // network id
export const GRANT_SIG = "PrimeSeatGrant(uint256 chainId,address safe,address seat,address key,uint64 start,uint64 end)";
export const chains = {
  BaseSepolia: { label: "Base Sepolia (84532)", slug: "evm", domain: 0, id: 84532 },
  SolanaDevnet: { label: "Solana devnet", slug: "solana", domain: 1 },
  StellarTestnet: { label: "Stellar testnet", slug: "stellar", domain: 1 },
} as const;
export type ChainName = keyof typeof chains;

const SCOPE = "Until it ends, this key approves and votes for you on this Prime Account beside a signature from one of its own wallets, and acts alone in rules that list your seat.";
export function scopeLine() {
  return SCOPE;
}

export type Addrs = { account: string; seat: string; key: string };
export function grantText(chain: ChainName, a: Addrs, start: number, end: number, scheme: string) {
  return [
    "Prime: start a session", `Chain: ${chains[chain].label}`, `Prime Account: ${a.account}`, `Your seat: ${a.seat}`, `Session key: ${a.key}`,
    `Starts: ${fmtTime(start)}`, `Ends: ${fmtTime(end)}`, scopeLine(), `Signature scheme: ${scheme}`, `Signer: ${SIGNER}`,
  ].join("\n");
}
export function endText(chain: ChainName, a: Addrs, scheme: string) {
  return ["Prime: end a session", `Chain: ${chains[chain].label}`, `Prime Account: ${a.account}`, `Your seat: ${a.seat}`, `Session key: ${a.key}`,
    "After this, the key can never act again.", `Signature scheme: ${scheme}`, `Signer: ${SIGNER}`].join("\n");
}

// Raw 32-byte forms of the three address kinds, for hashing
export function raw32(chain: ChainName, kind: "account" | "seat" | "key", s: string): Uint8Array {
  if (chain === "BaseSepolia") return cat(new Uint8Array(12), u8(s));
  if (chain === "SolanaDevnet") return new Uint8Array(new PublicKey(s).toBytes());
  return new Uint8Array(kind === "key" ? StrKey.decodeEd25519PublicKey(s) : StrKey.decodeContract(s));
}
export function grantHash(chain: ChainName, a: Addrs, start: number, end: number): Uint8Array {
  if (chain === "BaseSepolia") {
    const h = encodeAbiParameters(parseAbiParameters("bytes32, uint256, address, address, address, uint64, uint64"),
      [keccak256(utf8(GRANT_SIG)), 84532n, a.account as `0x${string}`, a.seat as `0x${string}`, a.key as `0x${string}`, BigInt(start), BigInt(end)]);
    return keccak256(toBytes(h), "bytes");
  }
  const dom = chain === "SolanaDevnet" ? utf8("devnet") : new Uint8Array(TESTNET_ID);
  return sha256(cat(utf8("prime-seat-grant"), dom, raw32(chain, "account", a.account), raw32(chain, "seat", a.seat), raw32(chain, "key", a.key), be8(start), be8(end)));
}
export { getAddress, hashTypedData, keccak256, toBytes, toHex, ed25519, sha256 };

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58encode(b: Uint8Array): string {
  let n = 0n; for (const x of b) n = n * 256n + BigInt(x);
  let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x === 0) s = "1" + s; else break; }
  return s;
}
