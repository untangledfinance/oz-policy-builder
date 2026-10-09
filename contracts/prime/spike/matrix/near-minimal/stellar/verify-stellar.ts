// Read-only checks on Stellar testnet for the architecture doc: which wasm each contract runs, what rule 0 and the
// session rules hold, and the network's persistent-entry TTL limits.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Sdk, server } from './stellar.ts';
const st = JSON.parse(readFileSync('state-stn.json', 'utf8'));
const x = Sdk.xdr;
async function wasmHashOf(c: string) {
  const key = x.LedgerKey.contractData(new x.LedgerKeyContractData({ contract: new Sdk.Address(c).toScAddress(), key: x.ScVal.scvLedgerKeyContractInstance(), durability: x.ContractDataDurability.persistent() }));
  const e = (await server.getLedgerEntries(key)).entries[0];
  return e ? e.val.contractData().val().instance().executable().wasmHash().toString('hex') : 'missing';
}
async function exportsOf(hash: string) {
  const key = x.LedgerKey.contractCode(new x.LedgerKeyContractCode({ hash: Buffer.from(hash, 'hex') }));
  const e = (await server.getLedgerEntries(key)).entries[0];
  const code = e.val.contractCode().code();
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
  const e = (await server.getLedgerEntries(key)).entries[0];
  const m = e.val.contractData().val().instance().storage()?.find((en) => en.key().switch().name === 'scvU32' && en.key().u32() === 0);
  return m ? Sdk.Address.fromScVal(m.val()).toString() : 'missing';
}
const big = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
console.log('latest ledger', (await server.getLatestLedger()).sequence);
const BUILD = '/home/ubuntu/git/github.com/untangledfinance/oz-policy-builder/contracts/prime/stellar/prime-session/target/wasm32v1-none/release/prime_session.wasm';
const buildHash = createHash('sha256').update(readFileSync(BUILD)).digest('hex');
console.log('build wasm sha256', buildHash, readFileSync(BUILD).length, 'bytes');
let mismatch = 0;
for (const k of ['prime', 'S_mm', 'S_fr', 'S_ph', 'S_rf']) {
  const h = await wasmHashOf(st[k]);
  const want = k === 'prime' ? undefined : buildHash;
  console.log(k, st[k], 'wasm', h, want ? (h === want ? '== build' : '!= build') : '');
  if (want && h !== want) mismatch++;
}
if (st.wasm !== buildHash) mismatch++;
const owners: Record<string, string> = { S_mm: st.G_mm_session, S_fr: st.G_fr, S_ph: st.G_ph_session, S_rf: st.G_rf };
for (const [k, want] of Object.entries(owners)) {
  const o = await ownerOf(st[k]);
  console.log(k, 'owner', o, o === want ? '== expected session owner' : `!= ${want}`);
  if (o !== want) mismatch++;
}
for (const [label, g] of [['seat MetaMask', st.G_mm], ['seat Phantom', st.G_ph], ['owner MetaMask', st.G_mm_session], ['owner Phantom', st.G_ph_session]] as const) {
  const a: any = await (await fetch(`https://horizon-testnet.stellar.org/accounts/${g}`)).json();
  const thr = `${a.thresholds.low_threshold}/${a.thresholds.med_threshold}/${a.thresholds.high_threshold}`, sg = a.signers.map((s: any) => `${s.key}:${s.weight}`).join(',');
  const ok = thr === '1/1/2' && sg === `${g}:1`;
  console.log(label, g, 'thresholds', thr, 'signers', sg, ok ? '== locked' : '!= locked');
  if (!ok) mismatch++;
}
console.log('uploaded wasm', st.wasm, st.wasm === buildHash ? '== build' : '!= build');
const acctHash = await wasmHashOf(st.prime);
console.log('account wasm exports', (await exportsOf(acctHash)).join(','));
console.log('prime-session wasm exports', (await exportsOf(st.wasm)).join(','));
for (const id of [0, st.r_mm ?? 3, st.r_fr ?? 4, st.r_ph ?? 5, st.r_rf ?? 6]) console.log(`rule ${id}`, JSON.stringify(await sim(st.prime, 'get_context_rule', Sdk.nativeToScVal(id, { type: 'u32' })), big).slice(0, 700));
const cfg = x.LedgerKey.configSetting(new x.LedgerKeyConfigSetting({ configSettingId: x.ConfigSettingId.configSettingStateArchival() }));
const a = (await server.getLedgerEntries(cfg)).entries[0].val.configSetting().stateArchivalSettings();
console.log('minPersistentTtl', a.minPersistentTtl(), 'maxEntryTtl', a.maxEntryTtl(), 'minTemporaryTtl', a.minTemporaryTtl());
if (mismatch) { console.log(`FAIL: ${mismatch} mismatches`); process.exit(1); }
console.log('OK: every prime-session instance runs the built wasm, has its expected owner, and every MPC-derived G account is locked');
