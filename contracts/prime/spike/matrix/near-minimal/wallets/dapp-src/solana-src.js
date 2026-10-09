import { Transaction, VersionedTransaction, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage } from '@solana/web3.js';
const err = (e) => { throw new Error('ERR ' + JSON.stringify(e instanceof Error ? { message: e.message, code: e.code } : e)); };
const wrap = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { err(e); } };
const keys = (o) => { try { return o ? [...new Set(Object.keys(o).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(o) ?? {})))].filter((k) => k !== 'constructor') : null; } catch { return null; } };
const P = {
  solflare: () => window.solflare,
  backpack: () => window.backpack?.solana ?? window.backpack,
  glow: () => window.glow?.solana ?? window.glowSolana ?? (window.solana?.isGlow ? window.solana : null),
};
const std = [];
window.addEventListener('wallet-standard:register-wallet', () => {});
try { window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: Object.freeze({ register: (w) => { std.push(w); return () => {}; } }) })); } catch {}
const prov = (n) => { const p = P[n](); if (!p) throw new Error('no provider ' + n); return p; };
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
window.wm = {
  detect: () => ({ solflare: keys(window.solflare), backpack: keys(window.backpack), backpackSol: keys(window.backpack?.solana), glow: keys(window.glow), glowSolana: keys(window.glowSolana), solana: keys(window.solana), flags: { isSolflare: window.solflare?.isSolflare, isBackpack: window.backpack?.isBackpack, isGlow: window.glow?.isGlow ?? window.solana?.isGlow }, std: std.map((w) => ({ name: w.name, version: w.version, features: Object.keys(w.features) })) }),
  connect: wrap(async (n) => { const p = prov(n); const r = await p.connect(); return (p.publicKey ?? r?.publicKey ?? r)?.toString(); }),
  signMessage: wrap(async (n, text) => { const r = await prov(n).signMessage(new TextEncoder().encode(text), 'utf8'); const sig = r.signature ?? r; return { sig: b64(sig), keys: Object.keys(r), pk: r.publicKey?.toString?.() }; }),
  signTransaction: wrap(async (n, txB64, versioned) => { const raw = fromB64(txB64); const tx = versioned ? VersionedTransaction.deserialize(raw) : Transaction.from(raw); const s = await prov(n).signTransaction(tx); return { signed: b64(s.serialize({ requireAllSignatures: false, verifySignatures: false })) }; }),
};
