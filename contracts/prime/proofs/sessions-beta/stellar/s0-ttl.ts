// Step 1: extend the prime-session wasm code entry (ContractCode) to the network's maximum TTL.
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { Sdk, server, friendbot, keypair, PASS, log } from './lib.ts';
const { xdr } = Sdk;
const HASH = 'e36d155f0381a466fb6c2c29b788a9d52e4a6f3e568f30da981609075bb7a0b3';
const fee = keypair('secrets/payer.json');
await friendbot(fee.publicKey());
const codeKey = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(HASH, 'hex') }));
const cfgKey = xdr.LedgerKey.configSetting(new xdr.LedgerKeyConfigSetting({ configSettingId: xdr.ConfigSettingId.configSettingStateArchival() }));
const cfg = (await server.getLedgerEntries(cfgKey)).entries[0]!.val.configSetting().stateArchivalSettings();
const maxTtl = cfg.maxEntryTtl();
const latest = (await server.getLatestLedger()).sequence;
const before = (await server.getLedgerEntries(codeKey)).entries[0]!.liveUntilLedgerSeq!;
log('latest', latest, 'max_entry_ttl', maxTtl, 'code liveUntil before', before);
// extendTo is relative to the current ledger; max_entry_ttl counts the current ledger, so ask for maxTtl - 1.
const extendTo = maxTtl - 1;
const op = Sdk.Operation.extendFootprintTtl({ extendTo });
const sorobanData = new Sdk.SorobanDataBuilder().setReadOnly([codeKey]).build();
const tx = new Sdk.TransactionBuilder(await server.getAccount(fee.publicKey()), { fee: '1000000', networkPassphrase: PASS })
  .addOperation(op).setSorobanData(sorobanData).setTimeout(120).build();
const prepared = await server.prepareTransaction(tx);
prepared.sign(fee);
const sent = await server.sendTransaction(prepared);
if (sent.status === 'ERROR') throw new Error(JSON.stringify(sent.errorResult).slice(0, 300));
let hash = sent.hash, ok = false;
for (let i = 0; i < 40; i++) { const r = await server.getTransaction(hash); if (r.status === 'SUCCESS') { ok = true; break; } if (r.status === 'FAILED') break; await new Promise((r) => setTimeout(r, 1000)); }
const after = (await server.getLedgerEntries(codeKey)).entries[0]!.liveUntilLedgerSeq!;
const afterLatest = (await server.getLatestLedger()).sequence;
const days = ((after - afterLatest) * 5) / 86400;
log('ok', ok, hash, 'liveUntil after', after, `(${days.toFixed(1)} days)`);
const res = existsSync('results.json') ? JSON.parse(readFileSync('results.json', 'utf8')) : {};
res.codeTtl = { ok, hash, codeHash: HASH, latestAtSend: latest, maxEntryTtl: maxTtl, before, after, daysAfter: Number(days.toFixed(1)), payer: fee.publicKey() };
writeFileSync('results.json', JSON.stringify(res, null, 1));
if (!ok || days < 30) process.exit(1);
