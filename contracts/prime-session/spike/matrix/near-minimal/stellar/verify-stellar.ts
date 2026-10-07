// Read-only checks on Stellar testnet for the architecture doc: which wasm each contract runs, what rule 0 and the
// session rules hold, and the network's persistent-entry TTL limits.
import { readFileSync } from 'node:fs';
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
const big = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
console.log('latest ledger', (await server.getLatestLedger()).sequence);
for (const k of ['prime', 'S_mm', 'S_fr', 'S_ph']) console.log(k, st[k], 'wasm', await wasmHashOf(st[k]));
const acctHash = await wasmHashOf(st.prime);
console.log('account wasm exports', (await exportsOf(acctHash)).join(','));
console.log('prime-session wasm exports', (await exportsOf(st.wasm)).join(','));
for (const id of [0, st.r_mm ?? 3, st.r_fr ?? 4, st.r_ph ?? 5]) console.log(`rule ${id}`, JSON.stringify(await sim(st.prime, 'get_context_rule', Sdk.nativeToScVal(id, { type: 'u32' })), big).slice(0, 700));
const cfg = x.LedgerKey.configSetting(new x.LedgerKeyConfigSetting({ configSettingId: x.ConfigSettingId.configSettingStateArchival() }));
const a = (await server.getLedgerEntries(cfg)).entries[0].val.configSetting().stateArchivalSettings();
console.log('minPersistentTtl', a.minPersistentTtl(), 'maxEntryTtl', a.maxEntryTtl(), 'minTemporaryTtl', a.minTemporaryTtl());
