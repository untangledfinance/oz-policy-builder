#!/usr/bin/env python3
"""Mutation pass over setup-checks.ts: each mutant changes one condition and the unit tests (bun test setup-checks.test.ts) must fail. Output: table on stdout."""
import os, shutil, subprocess, sys
D = os.path.dirname(os.path.abspath(__file__))
SRC = open(f'{D}/setup-checks.ts').read()
M = [
 ('s01', 'parseMultisig: n above 11 is accepted', "if (n > MAX_SIGNERS) throw", "if (n > 255) throw"),
 ('s02', 'parseMultisig: the initialised flag is ignored', "initialized: init === 1", "initialized: true"),
 ('s03', 'weight: a key counts once however many slots it holds', "return ms.slots.filter((s) => set.has(s.toBase58())).length;", "return new Set(ms.slots.filter((s) => set.has(s.toBase58())).map((s) => s.toBase58())).size;"),
 ('s04', 'checkMultisig: m greater than n is not reported', "if (ms.m > ms.n) out.push", "if (ms.m > ms.n + 100) out.push"),
 ('s05', 'checkMultisig: custody reaching m is not reported', "if (weight(ms, who.custody) >= ms.m)", "if (weight(ms, who.custody) > ms.m)"),
 ('s06', 'checkMultisig: a trustee reaching m alone is not reported', "if (weight(ms, [who.trustee]) >= ms.m)", "if (weight(ms, [who.trustee]) > ms.m)"),
 ('s07', 'checkMultisig: an unknown signer is not reported', "if (!known.has(s.toBase58())) out.push", "if (false) out.push"),
 ('s08', 'checkMultisig: m = 1 is not reported', "if (ms.m < 2) out.push", "if (ms.m < 1) out.push"),
 ('s09', 'weightedSlots: custody reaching m is allowed', "if (custody.length >= m) throw", "if (custody.length > m) throw"),
 ('s10', 'weightedSlots: the trustee gets one slot only', "Array.from({ length: m - 1 }, () => trustee)", "Array.from({ length: 1 }, () => trustee)"),
 ('s11', 'weightedSlots: more than 11 slots are allowed', "if (slots.length > MAX_SIGNERS) throw", "if (slots.length > 99) throw"),
 ('s12', 'parseTokenAccount: the close authority tag is read at the wrong offset', "closeAuthority: u32(data, 129) === 1 ? pk(data, 133) : null", "closeAuthority: u32(data, 125) === 1 ? pk(data, 133) : null"),
 ('s12b', 'parseTokenAccount: the delegate is read at the wrong offset', "delegate: u32(data, 72) === 1 ? pk(data, 76) : null", "delegate: u32(data, 68) === 1 ? pk(data, 76) : null"),
 ('s12c', 'parseTokenAccount: the native flag is read at the wrong offset', "native: u32(data, 109) === 1", "native: u32(data, 105) === 1"),
 ('s12d', 'parseTokenAccount: the frozen state is not read', "frozen: data[108] === 2", "frozen: false"),
 ('s12e', 'parseTokenAccount: an uninitialised account is accepted', "if (data[108] === 0) throw", "if (data[108] === 9) throw"),
 ('s13', 'checkSourceAccount: an associated account is accepted', "if (getAssociatedTokenAddressSync(a.mint, a.owner, true, program).equals(address)) out.push", "if (false) out.push"),
 ('s14', 'checkSourceAccount: extensions are accepted', "if (a.length !== TOKEN_ACCOUNT_LEN) out.push({ code: 'extensions', message: `${a.length} bytes: the account carries extensions (CPI", "if (a.length < 0) out.push({ code: 'extensions', message: `${a.length} bytes: the account carries extensions (CPI"),
 ('s15', 'checkSourceAccount: a frozen account is accepted', "if (a.frozen) out.push", "if (false) out.push"),
 ('s16', 'handOverIxs: owner before close authority', "[AuthorityType.CloseAccount, AuthorityType.AccountOwner]", "[AuthorityType.AccountOwner, AuthorityType.CloseAccount]"),
 ('s17', 'checkHandedOver: a foreign close authority is accepted', "const closeOk = a.native ? a.closeAuthority === null || a.closeAuthority.equals(gate) : a.closeAuthority?.equals(gate) === true;", "const closeOk = true;"),
 ('s18', 'checkHandedOver: a native account with a close authority is accepted', "a.native ? a.closeAuthority === null || a.closeAuthority.equals(gate) : a.closeAuthority?.equals(gate) === true;", "a.native ? true : a.closeAuthority?.equals(gate) === true;"),
 ('s19', 'checkHandedOver: a stale delegate is accepted', "if (a.delegate !== null || a.delegatedAmount !== 0n)", "if (false)"),
 ('s20', 'checkHandedOver: the owner is not compared', "if (!a.owner.equals(gate)) out.push", "if (false) out.push"),
 ('s21', 'legacySize: signatures are not counted', "compileToLegacyMessage();\n  return 1 + 64 * msg.header.numRequiredSignatures + msg.serialize().length;", "compileToLegacyMessage();\n  return 1 + msg.serialize().length;"),
 ('s21b', 'v0BestSize: signatures are not counted', "compileToV0Message([table]);\n  return 1 + 64 * msg.header.numRequiredSignatures + msg.serialize().length;", "compileToV0Message([table]);\n  return 1 + msg.serialize().length;"),
 ('s22', 'txShape: a transaction over the limit is called legacy', "legacySize(ixs, feePayer) <= TX_LIMIT ? 'legacy'", "legacySize(ixs, feePayer) <= 5000 ? 'legacy'"),
 ('s23', 'txShape: a version 0 transaction over the limit is accepted', "v0BestSize(ixs, feePayer) <= TX_LIMIT ? 'v0+lookup-table'", "v0BestSize(ixs, feePayer) <= 5000 ? 'v0+lookup-table'"),
 # checkMint
 ('n01', 'checkMint: an owner that is no token program is accepted', "if (program === null) return stop(", "if (false) return stop("),
 ('n02', 'checkMint: a classic mint with extra bytes is accepted', "(program === 'token' && d.length !== MINT_LEN)", "(false)"),
 ('n03', 'checkMint: an uninitialised mint is accepted', "if (d[45] !== 1) return stop", "if (d[45] === 9) return stop"),
 ('n04', 'checkMint: the freeze flag is read at the wrong offset', "const tag = u32(d, 46);", "const tag = u32(d, 42);"),
 ('n05', 'checkMint: a freeze authority gives no warning', "if (tag === 1) warn.push", "if (tag === 9) warn.push"),
 ('n06', 'checkMint: the freeze authority key is read at the wrong offset', "freeze authority ${pk(d, 50).toBase58()}", "freeze authority ${pk(d, 46).toBase58()}"),
 ('n07', 'checkMint: the freeze warning text changes', "while frozen, recovery and release are refused';", "while frozen, recovery and release are allowed';"),
 ('n08', 'checkMint: a bad flag on the mint authority is accepted', "if (tag > 1 || u32(d, 0) > 1)", "if (tag > 1)"),
 ('n09', 'checkMint: a bad flag on the freeze authority is accepted', "if (tag > 1 || u32(d, 0) > 1)", "if (u32(d, 0) > 1)"),
 ('n10', 'checkMint: Token-2022 gives no prefer-classic warning', "warn.push({ code: 'token-2022'", "if (false) warn.push({ code: 'token-2022'"),
 ('n11', 'checkMint: the Token-2022 mint marker is not checked', "d.length < MINT_TLV_START || d[MINT_ACCOUNT_TYPE] !== 1", "d.length < MINT_TLV_START"),
 ('n12', 'checkMint: a cut-off extension header is not caught', "if (o + 4 > d.length)", "if (o + 4 > d.length + 10)"),
 ('n13', 'checkMint: non-zero bytes after the last extension are accepted', "if (d.subarray(o).some((b) => b !== 0))", "if (false)"),
 ('n14', 'checkMint: a cut-off extension body is not caught', "if (o + 4 + len > d.length)", "if (o + 4 + len > d.length + 100)"),
 ('n15', 'checkMint: a transfer fee is accepted', "  1: ['transfer-fee',", "  101: ['transfer-fee',"),
 ('n16', 'checkMint: confidential transfer is accepted', "  4: ['confidential-transfer',", "  104: ['confidential-transfer',"),
 ('n17', 'checkMint: non-transferable is accepted', "  9: ['non-transferable',", "  109: ['non-transferable',"),
 ('n18', 'checkMint: a permanent delegate is accepted', "  12: ['permanent-delegate',", "  112: ['permanent-delegate',"),
 ('n19', 'checkMint: a transfer hook is accepted', "  14: ['transfer-hook',", "  114: ['transfer-hook',"),
 ('n20', 'checkMint: confidential transfer fees are accepted', "  16: ['confidential-transfer-fee',", "  116: ['confidential-transfer-fee',"),
 ('n21', 'checkMint: a confidential mint is accepted', "  24: ['confidential-mint-burn',", "  124: ['confidential-mint-burn',"),
 ('n22', 'checkMint: a frozen default account state is accepted', "if (v[0] === 2) refuse.push", "if (v[0] === 9) refuse.push"),
 ('n23', 'checkMint: a malformed default account state is accepted', "if (len !== 1 || (v[0] !== 1 && v[0] !== 2))", "if (len !== 1)"),
 ('n24', 'checkMint: a pausable mint gives no warning', "warn.push({ code: 'pausable'", "if (false) warn.push({ code: 'pausable'"),
 ('n25', 'checkMint: a pausable extension of the wrong length is accepted', "if (len !== PAUSABLE_LEN)", "if (len < 0)"),
 ('n26', 'checkMint: a benign extension of the wrong length is accepted', "if (want === 0 ? len < 76 : len !== want)", "if (false)"),
 ('n27', 'checkMint: a short token-metadata extension is accepted', "want === 0 ? len < 76", "want === 0 ? len < 0"),
 ('n28', 'checkMint: an unknown extension is accepted', "} else refuse.push({ code: 'unknown-extension'", "} else if (false) refuse.push({ code: 'unknown-extension'"),
 ('n29', 'checkMint: the metadata pointer length is wrong in the table', "18: ['metadata-pointer', 64]", "18: ['metadata-pointer', 65]"),
 ('n30', 'checkMint: an account-only extension type is treated as benign', "3: ['mint-close-authority', 32]", "3: ['mint-close-authority', 32], 7: ['immutable-owner', 0]"),
 # parseGate and checkGate
 ('g01', 'parseGate: a destination list that is not whole entries is accepted', "(data.length - GATE_FIXED_LEN) % 32 !== 0", "(data.length - GATE_FIXED_LEN) % 32 !== 99"),
 ('g02', 'parseGate: the agent lane is read at the wrong offset', "agentLane: pk(data, 64)", "agentLane: pk(data, 60)"),
 ('g03', 'parseGate: the owners lane is read at the wrong offset', "ownersLane: pk(data, 96)", "ownersLane: pk(data, 92)"),
 ('g04', 'parseGate: the recovery address is read at the wrong offset', "recovery: pk(data, 128)", "recovery: pk(data, 124)"),
 ('g05', 'parseGate: the end time is read at the wrong offset', "until: v.getBigInt64(160, true)", "until: v.getBigInt64(152, true)"),
 ('g06', 'parseGate: the window is read at the wrong offset', "window: v.getUint32(168, true)", "window: v.getUint32(164, true)"),
 ('g07', 'parseGate: the seed is read at the wrong offset', "seed: data.slice(172, 180)", "seed: data.slice(171, 179)"),
 ('g08', 'parseGate: the bump is read at the wrong offset', "bump: data[180]", "bump: data[179]"),
 ('g09', 'parseGate: the destinations start at the wrong offset', "(_, i) => pk(data, GATE_FIXED_LEN + 32 * i)", "(_, i) => pk(data, GATE_FIXED_LEN + 32 * i + 1)"),
 ('g10', 'parseGate: the multisig and settings are swapped', "multisig: pk(data, 0), settings: pk(data, 32)", "multisig: pk(data, 32), settings: pk(data, 0)"),
 ('g11', 'gateAddress: the seed prefix changes', "Buffer.from('gate')", "Buffer.from('gat3')"),
 ('g12', 'gateAddress: multisig and settings are swapped in the seeds', "multisig.toBuffer(), settings.toBuffer(), seed]", "settings.toBuffer(), multisig.toBuffer(), seed]"),
 ('c01', 'checkGate: an account owned by another program is accepted', "if (!gate.owner.equals(want.program)) return", "if (false) return"),
 ('c02', 'checkGate: a malformed account gives no issue', "catch (e) { return [{ code: 'gate-malformed', message: String((e as Error).message) }]; }", "catch (e) { return []; }"),
 ('c03', 'checkGate: the gate address is not compared', "key('gate-address', 'the gate address', gate.address, pda);", ""),
 ('c04', 'checkGate: the stored bump is not compared', "if (g.bump !== bump)", "if (false)"),
 ('c05', 'checkGate: the multisig is not compared', "key('gate-multisig', 'the custody multisig', g.multisig, want.multisig);", ""),
 ('c06', 'checkGate: the settings are not compared', "key('gate-settings', 'the Prime settings', g.settings, want.settings);", ""),
 ('c07', 'checkGate: the agent lane is not compared', "key('gate-agent-lane', 'the agent lane vault', g.agentLane, want.agentLane);", ""),
 ('c08', 'checkGate: the owners lane is not compared', "key('gate-owners-lane', 'the owners lane vault', g.ownersLane, want.ownersLane);", ""),
 ('c09', 'checkGate: the recovery address is not compared', "key('gate-recovery', 'the recovery address', g.recovery, want.recovery);", ""),
 ('c10', 'checkGate: the end time is not compared', "if (g.until !== BigInt(want.until))", "if (false)"),
 ('c11', 'checkGate: the window is not compared', "if (g.window !== want.window)", "if (false)"),
 ('c12', 'checkGate: the seed is not compared', "if (Buffer.compare(g.seed, want.seed) !== 0)", "if (false)"),
 ('c13', 'checkGate: the destination length is not compared', "g.destinations.length !== want.destinations.length ||", "false ||"),
 ('c14', 'checkGate: the destination entries are not compared', "g.destinations.some((x, i) => !x.equals(want.destinations[i]))", "false"),
 ('c15', 'checkGate: an empty recovery address is accepted', "if (g.recovery.equals(PublicKey.default))", "if (false)"),
 ('c16', 'checkGate: a recovery address equal to the multisig is accepted', "[want.multisig, ...want.custody].some(", "[...want.custody].some("),
 ('c17', 'checkGate: a recovery address equal to a custody key is accepted', "[want.multisig, ...want.custody].some(", "[want.multisig].some("),
 ('c18', 'checkGate: a recovery address that is a listed destination is accepted', "if (g.destinations.some((x) => x.equals(g.recovery)))", "if (false)"),
]
rows = []
shutil.copy(f'{D}/setup-checks.ts', '/tmp/setup-checks.a4min-fix.orig.ts')
try:
    for mid, desc, old, new in M:
        assert SRC.count(old) == 1, (mid, SRC.count(old))
        open(f'{D}/setup-checks.ts', 'w').write(SRC.replace(old, new))
        r = subprocess.run(['bun', 'test', 'setup-checks.test.ts'], cwd=D, capture_output=True, text=True)
        out = r.stdout + r.stderr
        failed = [l for l in out.splitlines() if l.startswith('(fail)')]
        rows.append((mid, desc, 'killed' if r.returncode != 0 else 'SURVIVED', failed[0][7:80] if failed else ''))
        print(rows[-1], flush=True)
finally:
    shutil.copy('/tmp/setup-checks.a4min-fix.orig.ts', f'{D}/setup-checks.ts')
print(len(rows), 'mutants,', sum(1 for r in rows if r[2] == 'killed'), 'killed')
