// Safe 1.4.1 contracts on Base Sepolia vs source at safe-smart-account tag v1.4.1.
// Build: `hardhat compile` in the repo at the tag (solc 0.7.6, optimizer disabled, as
// the 1.4.1 changelog states). For each contract: (1) CREATE2 through the Safe
// singleton factory with salt 0 gives the canonical address; (2) runtime code read from
// Base Sepolia equals the compiled deployed bytecode (immutables filled); (3) its keccak
// equals the canonical codeHash in safe-deployments.
const fs = require("fs"), path = require("path");
// SAFE_DIR: safe-global/safe-smart-account at tag v1.4.1 after `yarn install` and
// `npx hardhat compile` (Node 20). SDEP_DIR: safe-global/safe-deployments (any recent main).
// ETHERS: any ethers v5 install (the Roles checkout has one).
const SAFE = process.env.SAFE_DIR || "/tmp/bh/safe";
const SDEP = process.env.SDEP_DIR || "/tmp/bh/sdep";
const { ethers } = require(process.env.ETHERS || "/tmp/bh/roles/packages/evm/node_modules/ethers");
const RPC = process.env.RPC || "https://sepolia.base.org";
const provider = new ethers.providers.JsonRpcProvider(RPC);
const FACTORY = "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7";
const SALT = ethers.constants.HashZero;
const list = [
  ["SafeL2", "contracts/SafeL2.sol", "safe_l2"],
  ["SafeProxyFactory", "contracts/proxies/SafeProxyFactory.sol", "safe_proxy_factory"],
  ["MultiSend", "contracts/libraries/MultiSend.sol", "multi_send"],
  ["MultiSendCallOnly", "contracts/libraries/MultiSendCallOnly.sol", "multi_send_call_only"],
  ["CreateCall", "contracts/libraries/CreateCall.sol", "create_call"],
];
const infos = fs.readdirSync(SAFE + "/build/artifacts/build-info").map((f) => JSON.parse(fs.readFileSync(SAFE + "/build/artifacts/build-info/" + f, "utf8")));
(async () => {
  const net = await provider.getNetwork();
  console.log(`rpc ${RPC} chainId ${net.chainId} block ${await provider.getBlockNumber()}`);
  const fcode = await provider.getCode(FACTORY);
  console.log(`Safe singleton factory ${FACTORY} code keccak ${ethers.utils.keccak256(fcode)} (${(fcode.length - 2) / 2} B)`);
  let allOk = true;
  for (const [name, src, dep] of list) {
    const info = infos.find((b) => b.output.contracts[src] && b.output.contracts[src][name]);
    const c = info.output.contracts[src][name];
    const settings = { ...info.input.settings }; delete settings.outputSelection;
    const d = JSON.parse(fs.readFileSync(`${SDEP}/src/assets/v1.4.1/${dep}.json`, "utf8"));
    const canon = d.deployments.canonical;
    const init = "0x" + c.evm.bytecode.object;
    const predicted = ethers.utils.getCreate2Address(FACTORY, SALT, ethers.utils.keccak256(init));
    const addrOk = predicted.toLowerCase() === canon.address.toLowerCase();
    const onchain = await provider.getCode(canon.address);
    let runtime = c.evm.deployedBytecode.object;
    const imm = c.evm.deployedBytecode.immutableReferences || {};
    for (const refs of Object.values(imm)) for (const r of refs) // only immutable in these: MultiSend's own address
      runtime = runtime.slice(0, r.start * 2) + ethers.utils.hexZeroPad(canon.address, 32).slice(2).toLowerCase() + runtime.slice((r.start + r.length) * 2);
    runtime = "0x" + runtime;
    const runtimeOk = onchain.toLowerCase() === runtime.toLowerCase();
    const hashOk = ethers.utils.keccak256(onchain) === canon.codeHash;
    const ok = addrOk && runtimeOk && hashOk;
    allOk = allOk && ok;
    console.log(`${name} ${canon.address} (Base Sepolia listed in safe-deployments: ${d.networkAddresses["84532"] ?? "no"})`);
    console.log(`  compiler ${info.solcLongVersion} settings ${JSON.stringify(settings)}`);
    console.log(`  init code keccak ${ethers.utils.keccak256(init)}; CREATE2 = ${predicted} matches: ${addrOk}`);
    console.log(`  runtime on chain ${(onchain.length - 2) / 2} B keccak ${ethers.utils.keccak256(onchain)}`);
    console.log(`  runtime compiled ${(runtime.length - 2) / 2} B keccak ${ethers.utils.keccak256(runtime)} (immutables filled: ${Object.keys(imm).length})`);
    console.log(`  equal: ${runtimeOk}; safe-deployments codeHash ${canon.codeHash} equal: ${hashOk}`);
    console.log(`  RESULT ${ok ? "PASS" : "FAIL"}`);
  }
  console.log(allOk ? "ALL PASS" : "SOME FAIL");
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
