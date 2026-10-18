// Read-only checks on Stellar testnet for the seat-voting spike: which wasm each prime-seat runs, who owns it, what rule 0 and the
// session rules hold, and that the MPC-derived owner accounts are locked.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Sdk, server } from './stellar.ts';
const st = JSON.parse(readFileSync(process.env.SST_STATE ?? '/home/ubuntu/work/seat-spike/stellar/state-sst.json', 'utf8'));
const x = Sdk.xdr;
async function wasmHashOf(c: string) {
  const key = x.LedgerKey.contractData(new x.LedgerKeyContractData({ contract: new Sdk.Address(c).toScAddress(), key: x.ScVal.scvLedgerKeyContractInstance(), durability: x.ContractDataDurability.persistent() }));
  const e = (await server.getLedgerEntries(key)).entries[0];
  return e ? e.val.contractData().val().instance().executable().wasmHash().toString('hex') : 'missing';
}
async function exportsOf(hash: string) {
  const key = x.LedgerKey.contractCode(new x.LedgerKeyContractCode({ hash: Buffer.from(hash, 'hex') }));
  const code = (await server.getLedgerEntries(key)).entries[0]!.val.contractCode().code();
  return WebAssembly.Module.exports(new WebAssembly.Module(code)).map((m) => m.name).filter((n) => !n.startsWith('_') || n.startsWith('__')).sort();
}
const sim = async (c: string, fn: string, ...args: any[]) => {
  const acct = new Sdk.Account('GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7', '0');
  const tx = new Sdk.TransactionBuilder(acct, { fee: '100', networkPassphrase: Sdk.Networks.TESTNET }).addOperation(new Sdk.Contract(c).call(fn, ...args)).setTimeout(30).build();
  const r: any = await server.simulateTransaction(tx);
  return r.error ? `error ${r.error.slice(0, 120)}` : Sdk.scValToNative(r.result.retval);
};
async function ownerOf(c: string) {
  const key = x.LedgerKey.contractData(new x.LedgerKeyContractData({ contract: new Sdk.Address(c).toScAddress(), key: x.ScVal.scvLedgerKeyContractInstance(), durability: x.ContractDataDurability.persistent() }));
  const e = (await server.getLedgerEntries(key)).entries[0]!;
  const m = e.val.contractData().val().instance().storage()?.find((en) => en.key().switch().name === 'scvU32' && en.key().u32() === 0);
  return m ? Sdk.Address.fromScVal(m.val()).toString() : 'missing';
}
async function ttlOf(key: Sdk.xdr.LedgerKey) { return (await server.getLedgerEntries(key)).entries[0]?.liveUntilLedgerSeq; }
const latest = (await server.getLatestLedger()).sequence;
for (const k of ['S_mm', 'S_fr', 'S_ph', 'prime']) {
  const inst = await ttlOf(x.LedgerKey.contractData(new x.LedgerKeyContractData({ contract: new Sdk.Address(st[k]).toScAddress(), key: x.ScVal.scvLedgerKeyContractInstance(), durability: x.ContractDataDurability.persistent() })));
  console.log(k, 'instance entry lives until ledger', inst, `(${inst! - latest} ledgers, about ${((inst! - latest) * 5 / 86400).toFixed(0)} days from now)`);
}
console.log('prime-seat code entry lives until ledger', await ttlOf(x.LedgerKey.contractCode(new x.LedgerKeyContractCode({ hash: Buffer.from(st.wasm, 'hex') }))));
const big = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
console.log('latest ledger', (await server.getLatestLedger()).sequence);
const BUILD = '/home/ubuntu/work/seat-spike/stellar/prime-seat/target/wasm32v1-none/release/prime_seat.wasm';
const buildHash = createHash('sha256').update(readFileSync(BUILD)).digest('hex');
console.log('build wasm sha256', buildHash, readFileSync(BUILD).length, 'bytes');
let mismatch = 0;
for (const k of ['S_mm', 'S_fr', 'S_ph']) {
  const h = await wasmHashOf(st[k]);
  console.log(k, st[k], 'wasm', h, h === buildHash ? '== build' : '!= build');
  if (h !== buildHash) mismatch++;
}
if (st.wasm !== buildHash) mismatch++;
console.log('uploaded wasm', st.wasm, st.wasm === buildHash ? '== build' : '!= build');
const owners: Record<string, string> = { S_mm: st.G_mm, S_fr: st.G_fr, S_ph: st.G_ph };
for (const [k, want] of Object.entries(owners)) {
  const o = await ownerOf(st[k]);
  console.log(k, 'owner', o, o === want ? '== expected owner' : `!= ${want}`);
  if (o !== want) mismatch++;
}
for (const [label, g] of [['owner MetaMask', st.G_mm], ['owner Phantom', st.G_ph]] as const) {
  const a: any = await (await fetch(`https://horizon-testnet.stellar.org/accounts/${g}`)).json();
  const thr = `${a.thresholds.low_threshold}/${a.thresholds.med_threshold}/${a.thresholds.high_threshold}`, sg = a.signers.map((s: any) => `${s.key}:${s.weight}`).join(',');
  const ok = thr === '1/1/2' && sg === `${g}:1`;
  console.log(label, g, 'thresholds', thr, 'signers', sg, ok ? '== locked' : '!= locked');
  if (!ok) mismatch++;
}
const acctHash = await wasmHashOf(st.prime);
console.log('account wasm', acctHash, acctHash === '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9' ? '== the OpenZeppelin smart account used in production' : '!= production');
if (acctHash !== '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9') mismatch++;
console.log('prime-seat wasm exports', (await exportsOf(st.wasm)).join(','));
for (const id of [0, st.r_probe, st.r_mm, st.r_fr, st.r_ph]) console.log(`rule ${id}`, JSON.stringify(await sim(st.prime, 'get_context_rule', Sdk.nativeToScVal(id, { type: 'u32' })), big).slice(0, 600));
if (st.prime2) { console.log('account 2', st.prime2, 'wasm', await wasmHashOf(st.prime2)); for (const id of [0, st.r2_probe, st.r2_ops]) console.log(`account 2 rule ${id}`, JSON.stringify(await sim(st.prime2, 'get_context_rule', Sdk.nativeToScVal(id, { type: 'u32' })), big).slice(0, 600)); }
const cfg = x.LedgerKey.configSetting(new x.LedgerKeyConfigSetting({ configSettingId: x.ConfigSettingId.configSettingStateArchival() }));
const a = (await server.getLedgerEntries(cfg)).entries[0]!.val.configSetting().stateArchivalSettings();
console.log('minPersistentTtl', a.minPersistentTtl(), 'maxEntryTtl', a.maxEntryTtl(), 'minTemporaryTtl', a.minTemporaryTtl());
if (mismatch) { console.log(`FAIL: ${mismatch} mismatches`); process.exit(1); }
console.log('OK: every prime-seat instance runs the built wasm, has its expected owner, and the MPC-derived owner accounts are locked');
