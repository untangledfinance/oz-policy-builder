// Zodiac Roles v2.1.1 mastercopies on Base Sepolia vs source at 218a5164.
// For each mastercopy: (1) every source in the recorded compiler input equals the
// file at the commit (repo tree, or node_modules after the repo's own prebuild patch);
// (2) solc 0.8.21 on that input gives the recorded init code; (3) CREATE2 through the
// ERC-2470 factory with the recorded salt gives the recorded address; (4) the runtime
// code read from Base Sepolia equals solc's deployed bytecode.
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
// ROLES_DIR: a checkout of gnosisguild/zodiac-modifier-roles at 218a5164, with
// `yarn install --frozen-lockfile` and `node scripts/patch-zodiac-signature-checker.js`
// run in packages/evm (the repository's own prebuild step). SOLC: solc 0.8.21 (linux-amd64).
const EVM = (process.env.ROLES_DIR || "/tmp/bh/roles") + "/packages/evm";
const { ethers } = require(EVM + "/node_modules/ethers");
const SOLC = process.env.SOLC || process.env.HOME + "/.cache/hardhat-nodejs/compilers-v2/linux-amd64/solc-linux-amd64-v0.8.21+commit.d9974bed";
const RPC = process.env.RPC || "https://sepolia.base.org";
const provider = new ethers.providers.JsonRpcProvider(RPC);
const m = JSON.parse(fs.readFileSync(EVM + "/mastercopies.json", "utf8"));
const want = [["Roles", "2.1.1"], ["Integrity", "2.1.1"], ["Packer", "2.1.1"], ["MultiSendUnwrapper", "2.1.1"]];
(async () => {
  const net = await provider.getNetwork();
  const block = await provider.getBlockNumber();
  console.log(`rpc ${RPC} chainId ${net.chainId} block ${block}`);
  const factoryCode = await provider.getCode("0xce0042B868300000d44A59004Da54A005ffdcf9f");
  console.log(`ERC-2470 factory code keccak ${ethers.utils.keccak256(factoryCode)} (${(factoryCode.length - 2) / 2} B)`);
  let allOk = true;
  for (const [name, ver] of want) {
    const e = m[name][ver];
    const input = e.compilerInput;
    // (1) recorded sources == repo files
    let srcOk = true, nSrc = 0;
    for (const [p, { content }] of Object.entries(input.sources)) {
      nSrc++;
      const f = p.startsWith("contracts/") ? path.join(EVM, p) : path.join(EVM, "node_modules", p);
      const disk = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
      if (disk !== content) { srcOk = false; console.log(`  source differs: ${p}`); }
    }
    // (2) compile
    // The recorded init code was compiled with no libraries in the settings and linked
    // afterwards (Hardhat's way), so compile that way and link the recorded addresses.
    const libs = input.settings.libraries || {};
    const std = { ...input, settings: { optimizer: input.settings.optimizer, outputSelection: { "*": { "*": ["evm.bytecode.object", "evm.bytecode.linkReferences", "evm.deployedBytecode.object", "evm.deployedBytecode.linkReferences", "evm.deployedBytecode.immutableReferences"] } } } };
    const link = (b) => { let o = b.object; for (const [f, ls] of Object.entries(b.linkReferences || {})) for (const [n, refs] of Object.entries(ls)) for (const r of refs) o = o.slice(0, r.start * 2) + libs[f][n].slice(2).toLowerCase() + o.slice((r.start + r.length) * 2); return o; };
    const out = JSON.parse(execFileSync(SOLC, ["--standard-json"], { input: JSON.stringify(std), maxBuffer: 1 << 28 }).toString());
    const errs = (out.errors || []).filter((x) => x.severity === "error");
    if (errs.length) throw new Error(errs.map((x) => x.formattedMessage).join("\n"));
    const c = out.contracts[e.sourceName][e.contractName];
    const args = ethers.utils.defaultAbiCoder.encode(e.constructorArgs.types, e.constructorArgs.values);
    const init = "0x" + link(c.evm.bytecode) + args.slice(2);
    const initRecorded = e.bytecode.toLowerCase() === ("0x" + link(c.evm.bytecode)).toLowerCase();
    // (3) CREATE2
    const predicted = ethers.utils.getCreate2Address(e.factory, e.salt, ethers.utils.keccak256(init));
    const addrOk = predicted.toLowerCase() === e.address.toLowerCase();
    // (4) runtime
    const onchain = await provider.getCode(e.address);
    const imm = c.evm.deployedBytecode.immutableReferences || {};
    // A library's runtime starts with PUSH20 <zero address>, which the EVM-side deploy
    // fills with the library's own address (call protection); fill it the same way.
    let runtime = "0x" + link(c.evm.deployedBytecode);
    const isLib = runtime.startsWith("0x73" + "00".repeat(20));
    if (isLib) runtime = "0x73" + e.address.slice(2).toLowerCase() + runtime.slice(44);
    const runtimeOk = Object.keys(imm).length === 0 && onchain.toLowerCase() === runtime.toLowerCase();
    const ok = srcOk && initRecorded && addrOk && runtimeOk;
    allOk = allOk && ok;
    console.log(`${name} ${ver} ${e.address}`);
    console.log(`  sources in recorded input: ${nSrc}, all equal to the files at the commit: ${srcOk}`);
    console.log(`  settings: ${JSON.stringify({ ...input.settings, outputSelection: undefined })}`);
    console.log(`  init code keccak ${ethers.utils.keccak256(init)} equals recorded: ${initRecorded}`);
    console.log(`  CREATE2(factory ${e.factory}, salt ${e.salt}) = ${predicted} matches: ${addrOk}`);
    console.log(`  runtime on chain ${(onchain.length - 2) / 2} B keccak ${ethers.utils.keccak256(onchain)}`);
    console.log(`  runtime compiled ${(runtime.length - 2) / 2} B keccak ${ethers.utils.keccak256(runtime)} immutables ${Object.keys(imm).length}${isLib ? ", library: own address filled at byte 1" : ""}`);
    console.log(`  RESULT ${ok ? "PASS" : "FAIL"}`);
  }
  console.log(allOk ? "ALL PASS" : "SOME FAIL");
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
