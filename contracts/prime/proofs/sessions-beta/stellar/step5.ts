import { writeFileSync, readFileSync } from 'node:fs';
import { Sdk, server } from './lib.ts';
const res = JSON.parse(readFileSync('results.json', 'utf8'));
const g = Sdk.Keypair.random().publicKey();
const t = await fetch(`https://friendbot.stellar.org?addr=${g}`);
const body: any = await t.json().catch(() => ({}));
res.friendbot = { status: t.status, freshKey: g, hash: body.hash ?? body.id, ok: t.ok, note: 'friendbot funds a fresh throwaway key with 10,000 XLM; fresh key only, no secret kept' };
const fee = async (h: string) => Number(((await server.getTransaction(h)) as any).resultXdr.feeCharged().toString());
const hs = res.S1.results;
res.fees = {
  moveViaPrimeSession: await fee(hs.moveViaA.hash), grantFromKeyAccount: res.S4.grantFeeStroops, grantFromRelayer: res.S1.grants.a.fee,
  ruleInstall: await fee(res.S1.ruleInstallTx), deployPrimeSession: res.S2.deployFeeStroops, extendTtlInstance: res.S3.extendFeeStroops,
  revokeByKey: res.S5.revokeFeeStroops, revokeByOwner: res.S6.revokeFeeStroops, accountMerge: res.S5.mergeFeeStroops, createAccount: res.S4.createAccountFee,
  note: 'stroops, Horizon/RPC fee_charged. 1 XLM = 10,000,000 stroops',
};
writeFileSync('results.json', JSON.stringify(res, null, 1));
console.log(JSON.stringify(res.friendbot), JSON.stringify(res.fees));
