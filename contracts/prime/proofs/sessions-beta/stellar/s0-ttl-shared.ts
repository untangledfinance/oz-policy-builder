// Extra prep: extend the shared testnet contracts new Session moves rules install against (account code, grammar-6 interpreter, simple_threshold) to about 58 days (1,000,000 ledgers; the maximum would cost over 4 billion stroops of rent for the 55 KB account code).
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { Sdk, server, keypair, PASS, log } from './lib.ts';
const { xdr } = Sdk;
const fee = keypair('secrets/payer.json');
const code = (h: string) => xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(h, 'hex') }));
const inst = (id: string) => xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Sdk.Address(id).toScAddress(), key: xdr.ScVal.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent() }));
const keys = [
  code('91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9'),
  code('a7ef48e39875f18e4487e40b986d99463427ee28f89dac7e1665fff428033423'), inst('CDPR5VTX6R2ZPKREPD7FBW5ANVWXMVJIBIH2GMF36XPOFNMHRDIRUAZQ'),
  code('01c0be09eb6fb288cab2e878b4e890f7a38f75afab99aeb197861f44e2e2dfe6'), inst('CAYTIVQOEZDOQI4GC3XBXEEYHQUANQQJHPJVMXVRBREGSAP6TCN3DID6'),
];
const read = async () => (await server.getLedgerEntries(...keys)).entries.map((e) => e.liveUntilLedgerSeq);
const before = await read();
const sorobanData = new Sdk.SorobanDataBuilder().setReadOnly(keys).build();
const tx = new Sdk.TransactionBuilder(await server.getAccount(fee.publicKey()), { fee: '100', networkPassphrase: PASS }).addOperation(Sdk.Operation.extendFootprintTtl({ extendTo: 1_000_000 })).setSorobanData(sorobanData).setTimeout(120).build();
const prepared = await server.prepareTransaction(tx); prepared.sign(fee);
const sent = await server.sendTransaction(prepared);
let ok = false;
for (let i = 0; i < 40; i++) { const r = await server.getTransaction(sent.hash); if (r.status === 'SUCCESS') { ok = true; break; } if (r.status === 'FAILED') break; await new Promise((r) => setTimeout(r, 1000)); }
const after = await read();
log('ok', ok, sent.hash, before, after);
const res = JSON.parse(readFileSync('results.json', 'utf8'));
res.sharedTtl = { ok, hash: sent.hash, entries: ['account wasm 91a2cd56', 'interpreter wasm a7ef48e3', 'interpreter instance CDPR5VTX', 'simple_threshold wasm 01c0be09', 'simple_threshold instance CAYTIVQO'], before, after };
writeFileSync('results.json', JSON.stringify(res, null, 1));
