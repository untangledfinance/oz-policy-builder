// Round 8: read-only evidence for doc claims that had no log (no signing, no transactions).
import * as Sdk from '@stellar/stellar-sdk';
const x = Sdk.xdr;
const j = (u: string, b: unknown) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

// 1. Squads Smart Account program on devnet: last deploy slot (ProgramData header: u32 tag, u64 slot).
const SA = 'SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG';
const prog: any = await j('https://api.devnet.solana.com', { jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [SA, { encoding: 'base64' }] });
const pd = (await import('bs58')).default.encode(Buffer.from(prog.result.value.data[0], 'base64').subarray(4, 36));
const pda: any = await j('https://api.devnet.solana.com', { jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [pd, { encoding: 'base64', dataSlice: { offset: 0, length: 12 } }] });
const slot = Buffer.from(pda.result.value.data[0], 'base64').readBigUInt64LE(4);
const t: any = await j('https://api.devnet.solana.com', { jsonrpc: '2.0', id: 1, method: 'getBlockTime', params: [Number(slot)] });
console.log('squads devnet program', SA, 'programdata', pd, 'last deploy slot', slot.toString(), 'block time', t.result ? new Date(t.result * 1000).toISOString() : JSON.stringify(t.error));

// 2. Stellar persistent-entry minimum lifetime, testnet and mainnet.
for (const [name, url] of [['testnet', 'https://soroban-testnet.stellar.org'], ['mainnet', 'https://mainnet.sorobanrpc.com']]) {
  const server = new Sdk.rpc.Server(url);
  const cfg = x.LedgerKey.configSetting(new x.LedgerKeyConfigSetting({ configSettingId: x.ConfigSettingId.configSettingStateArchival() }));
  const a = (await server.getLedgerEntries(cfg)).entries[0]!.val.configSetting().stateArchivalSettings();
  console.log(`stellar ${name} minPersistentTtl`, a.minPersistentTtl());
}

// 3. Live Base Sepolia relayer balance.
const bal: any = await j('https://sepolia.base.org', { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: ['0xecebBf71Faa6682Ff31fD145646f8Eda82E98E11', 'latest'] });
console.log('base sepolia relayer 0xeceb…8E11 balance (ETH)', Number(BigInt(bal.result)) / 1e18);

// 4. Solana devnet airdrop for the payer (read-only request; refused when rate-limited).
const ad: any = await j('https://api.devnet.solana.com', { jsonrpc: '2.0', id: 1, method: 'requestAirdrop', params: ['5bevLKtW8bA6LCXXMqQAjnWBRCWcSXwcvQHiCbT6JjuY', 1e9] });
console.log('devnet airdrop', new Date().toISOString(), ad.error ? `refused: ${JSON.stringify(ad.error)}` : `ok ${ad.result}`);
