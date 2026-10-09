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
]
rows = []
shutil.copy(f'{D}/setup-checks.ts', '/tmp/setup-checks.orig.ts')
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
    shutil.copy('/tmp/setup-checks.orig.ts', f'{D}/setup-checks.ts')
print(len(rows), 'mutants,', sum(1 for r in rows if r[2] == 'killed'), 'killed')
