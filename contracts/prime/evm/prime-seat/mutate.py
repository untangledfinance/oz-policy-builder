#!/usr/bin/env python3
"""Mutation pass for src/PrimeSeat.sol on a scratch copy of the project (the working tree is never edited). Each mutant
edits one spot, then the whole forge suite runs (the Safe fork tests need FORK_URL). A mutant is killed when the suite
fails or the build breaks. Usage: FORK_URL=... ./mutate.py out.json"""
import json, os, shutil, subprocess, sys, tempfile

SRC = "src/PrimeSeat.sol"  # relative to the scratch copy made in main()
FORGE = shutil.which("forge") or os.path.expanduser("~/.foundry/bin/forge")
H = "keccak256(abi.encode(GRANT, block.chainid, safe, this, key, start, end))"
X = "keccak256(abi.encode(this, block.chainid, sessions[key].nonce++, to, value, keccak256(data), op, role))"
M = [
    # constants, storage layout, constructor
    ("typehash text", "address key,uint64 start", "address  key,uint64 start"),
    ("typehash chainId name", "uint256 chainId,", "uint256 chain,"),
    ("start widened (slot split)", "uint64 start;", "uint128 start;"),
    ("end widened (slot split)", "uint64 end; //", "uint128 end; //"),
    ("nonce narrowed", "uint128 nonce;", "uint64 nonce;"),
    ("owner not stored", "(owner, safe, roles) = (owner_, safe_, roles_)", "(owner, safe, roles) = (address(0), safe_, roles_)"),
    ("safe not stored", "(owner, safe, roles) = (owner_, safe_, roles_)", "(owner, safe, roles) = (owner_, address(0), roles_)"),
    ("roles not stored", "(owner, safe, roles) = (owner_, safe_, roles_)", "(owner, safe, roles) = (owner_, safe_, IRoles(address(0)))"),
    # grant hash
    ("grant hash drops typehash", H, H.replace("GRANT, ", "")),
    ("grant hash drops chainid", H, H.replace("block.chainid, ", "")),
    ("grant hash drops safe", H, H.replace("safe, ", "")),
    ("grant hash drops seat", H, H.replace("this, ", "")),
    ("grant hash drops key", H, H.replace("key, start", "start")),
    ("grant hash drops start", H, H.replace("start, end", "end")),
    ("grant hash drops end", H, H.replace("start, end)", "start)")),
    ("grant hash packed", "keccak256(abi.encode(GRANT, block.chainid, safe, this, key, start, end))", "keccak256(abi.encodePacked(GRANT, block.chainid, safe, this, key, start, end))"),
    # grant signer
    ("grant: owner test negated", "who == owner ||", "who != owner ||"),
    ("grant: owner test dropped", "who == owner ||", "false ||"),
    ("grant: any signer", "who == owner ||", "true ||"),
    ("grant: key may start itself", "(end == 0 && who == key)", "(who == key)"),
    ("grant: end test negated", "(end == 0 && who == key)", "(end != 0 && who == key)"),
    ("grant: key may not end itself", "(end == 0 && who == key)", "false"),
    ("grant: end signed by anyone", "(end == 0 && who == key)", "(end == 0)"),
    ("grant: end signed by owner key only", "(end == 0 && who == key)", "(end == 0 && who == owner)"),
    # grant effects
    ("grant: branch negated", "if (end == 0) {", "if (end != 0) {"),
    ("grant: end marker max-1", "s.end = type(uint64).max;", "s.end = type(uint64).max - 1;"),
    ("grant: end marker zero", "s.end = type(uint64).max;", "s.end = 0;"),
    ("grant: end marker removed", "s.end = type(uint64).max;", ""),
    ("grant: start == now refused", "require(start <= block.timestamp &&", "require(start < block.timestamp &&"),
    ("grant: future start allowed", "require(start <= block.timestamp &&", "require(true &&"),
    ("grant: end == now refused", "block.timestamp <= end &&", "block.timestamp < end &&"),
    ("grant: ended window allowed", "block.timestamp <= end &&", "true &&"),
    ("grant: 7 days exclusive", "end - start <= 7 days", "end - start < 7 days"),
    ("grant: 8 days allowed", "end - start <= 7 days", "end - start <= 8 days"),
    ("grant: window unbounded", "end - start <= 7 days &&", "true &&"),
    ("grant: equal end allowed", "end > s.end", "end >= s.end"),
    ("grant: shorter end allowed", "end > s.end", "true"),
    ("grant: stored start kept", "(s.start, s.end) = (start, end);", "(s.start, s.end) = (s.start, end);"),
    ("grant: stored end kept", "(s.start, s.end) = (start, end);", "(s.start, s.end) = (start, s.end);"),
    ("grant: stored end off by one", "(s.start, s.end) = (start, end);", "(s.start, s.end) = (start, end + 1);"),
    ("grant: stored start off by one", "(s.start, s.end) = (start, end);", "(s.start, s.end) = (start + 1, end);"),
    ("grant: stored in wrong key", "Session storage s = sessions[key];", "Session storage s = sessions[owner];"),
    ("grant: window checks joined by or (1)", "start <= block.timestamp && block.timestamp <= end &&", "start <= block.timestamp || block.timestamp <= end &&"),
    ("grant: window checks joined by or (2)", "block.timestamp <= end && end - start", "block.timestamp <= end || end - start"),
    ("grant: window checks joined by or (3)", "end - start <= 7 days && end > s.end", "end - start <= 7 days || end > s.end"),
    ("grant: revert text", '"grant");', '"x");'),
    # exec guards
    ("exec: liveness dropped", "live(key) && op == 0 && to != safe", "true && op == 0 && to != safe"),
    ("exec: delegatecall allowed", "&& op == 0 &&", "&& op <= 1 &&"),
    ("exec: operation unchecked", "&& op == 0 &&", "&& true &&"),
    ("exec: safe allowed", "to != safe &&", "true &&"),
    ("exec: enabled module allowed", "!ISafe(safe).isModuleEnabled(to) &&", "true &&"),
    ("exec: module test negated", "!ISafe(safe).isModuleEnabled(to) &&", "ISafe(safe).isModuleEnabled(to) &&"),
    ("exec: seat allowed", "to != address(this),", "true,"),
    ("exec: guards joined by or (1)", "live(key) && op == 0", "live(key) || op == 0"),
    ("exec: guards joined by or (2)", "op == 0 && to != safe", "op == 0 || to != safe"),
    ("exec: guards joined by or (3)", "to != safe && !ISafe(safe).isModuleEnabled(to)", "to != safe || !ISafe(safe).isModuleEnabled(to)"),
    ("exec: guards joined by or (4)", "isModuleEnabled(to) && to != address(this)", "isModuleEnabled(to) || to != address(this)"),
    # exec digest
    ("exec digest drops seat", X, X.replace("this, ", "address(0), ")),
    ("exec digest drops chainid", X, X.replace("block.chainid, ", "uint256(1), ")),
    ("exec digest keeps nonce", X, X.replace("nonce++", "nonce")),
    ("exec digest pre-increments nonce", X, X.replace("nonce++", "++sessions[key].nonce")),
    ("exec digest drops to", X, X.replace(", to, value", ", address(0), value")),
    ("exec digest drops value", X, X.replace(", value, keccak", ", uint256(0), keccak")),
    ("exec digest drops data", X, X.replace("keccak256(data)", 'keccak256("")')),
    ("exec digest drops op", X, X.replace(", op, role", ", uint8(0), role")),
    ("exec digest drops role", X, X.replace(", op, role", ", op, bytes32(0)")),
    ("exec digest packed", X, X.replace("abi.encode(", "abi.encodePacked(")),
    ("exec: signer negated", "ECDSA.recover(h, sig) == key", "ECDSA.recover(h, sig) != key"),
    ("exec: signer unchecked", "ECDSA.recover(h, sig) == key", "ECDSA.recover(h, sig) == key || true"),
    ("exec: owner signs for key", "ECDSA.recover(h, sig) == key", "ECDSA.recover(h, sig) == owner"),
    # exec forwarding
    ("exec: shouldRevert off", "role, true);", "role, false);"),
    ("exec: value dropped", "execTransactionWithRole(to, value, data, op, role, true)", "execTransactionWithRole(to, 0, data, op, role, true)"),
    ("exec: data dropped", "execTransactionWithRole(to, value, data, op, role, true)", 'execTransactionWithRole(to, value, "", op, role, true)'),
    ("exec: op dropped", "execTransactionWithRole(to, value, data, op, role, true)", "execTransactionWithRole(to, value, data, 0, role, true)"),
    ("exec: role dropped", "execTransactionWithRole(to, value, data, op, role, true)", "execTransactionWithRole(to, value, data, op, bytes32(0), true)"),
    ("exec: to dropped", "execTransactionWithRole(to, value, data, op, role, true)", "execTransactionWithRole(address(0), value, data, op, role, true)"),
    ("exec: roles call removed", "roles.execTransactionWithRole(to, value, data, op, role, true);", ""),
    ("exec: nonce kept per owner", "sessions[key].nonce++", "sessions[owner].nonce++"),
    # 1.5.0 form
    ("vote: any caller", "(msg.sender == safe || msg.sender == address(0))", "true"),
    ("vote: address 0 refused", " || msg.sender == address(0))", ")"),
    ("vote: only address 0 asks", "(msg.sender == safe ||", "(false ||"),
    ("vote: caller negated", "(msg.sender == safe ||", "(msg.sender != safe ||"),
    ("vote: address 0 negated", "msg.sender == address(0))", "msg.sender != address(0))"),
    ("vote: key liveness dropped", "live(ECDSA.recover(keccak256(abi.encode(this, h)), sig[:65]))", "(ECDSA.recover(keccak256(abi.encode(this, h)), sig[:65]) != address(0))"),
    ("vote: proof does not name the seat", "keccak256(abi.encode(this, h))", "keccak256(abi.encode(address(0), h))"),
    ("vote: proof is the bare hash", "keccak256(abi.encode(this, h))", "h"),
    ("vote: proof hashed packed", "keccak256(abi.encode(this, h))", "keccak256(abi.encodePacked(this, h))"),
    ("vote: key part shifted", "sig[:65]", "sig[:64]"),
    ("vote: native part shifted", "sig[65:]", "sig[64:]"),
    ("vote: native part clipped", "sig[65:]", "sig[65:130]"),
    ("vote: native check dropped", "ISafe(safe).isOwner(ECDSA.recover(h, sig[65:]))", "true"),
    ("vote: native check negated", "ISafe(safe).isOwner(ECDSA.recover(h, sig[65:]))", "!ISafe(safe).isOwner(ECDSA.recover(h, sig[65:]))"),
    ("vote: native over another hash", "ECDSA.recover(h, sig[65:])", "ECDSA.recover(keccak256(abi.encode(h)), sig[65:])"),
    ("vote: native recovered from key part", "ECDSA.recover(h, sig[65:])", "ECDSA.recover(h, sig[:65])"),
    ("vote: conditions joined by or (1)", "address(0))\n            && live(", "address(0))\n            || live("),
    ("vote: conditions joined by or (2)", "sig[:65]))\n            && ISafe", "sig[:65]))\n            || ISafe"),
    ("vote: success value", "bytes4(0x1626ba7e)", "bytes4(0x1626ba7f)"),
    ("vote: failure value", ": bytes4(0xffffffff);\n    }\n\n    /// Safe 1.4.1", ": bytes4(0xfffffffe);\n    }\n\n    /// Safe 1.4.1"),
    ("vote: always success", "? bytes4(0x1626ba7e)\n            : bytes4(0xffffffff);\n    }\n\n    /// Safe 1.4.1", "? bytes4(0x1626ba7e)\n            : bytes4(0x1626ba7e);\n    }\n\n    /// Safe 1.4.1"),
    # 1.4.1 form
    ("legacy: length unchecked", "data.length == 66 &&", "true &&"),
    ("legacy: length at least", "data.length == 66 &&", "data.length >= 66 &&"),
    ("legacy: length at most", "data.length == 66 &&", "data.length <= 66 &&"),
    ("legacy: prefix unchecked", "bytes2(data) == 0x1901 &&", "true &&"),
    ("legacy: prefix negated", "bytes2(data) == 0x1901 &&", "bytes2(data) != 0x1901 &&"),
    ("legacy: inner result unchecked", "isValidSignature(keccak256(data), sig) == 0x1626ba7e", "true"),
    ("legacy: inner on bare data", "isValidSignature(keccak256(data), sig) == 0x1626ba7e", "isValidSignature(bytes32(data[2:34]), sig) == 0x1626ba7e"),
    ("legacy: success value", "bytes4(0x20c13b0b)", "bytes4(0x20c13b0c)"),
    ("legacy: failure value", "            : bytes4(0xffffffff);\n    }\n\n    function live", "            : bytes4(0xfffffffe);\n    }\n\n    function live"),
    ("legacy: conditions joined by or (1)", "data.length == 66 && bytes2", "data.length == 66 || bytes2"),
    ("legacy: conditions joined by or (2)", "0x1901 && isValidSignature", "0x1901 || isValidSignature"),
    # liveness
    ("live: start == now refused", "s.start <= block.timestamp &&", "s.start < block.timestamp &&"),
    ("live: start unchecked", "s.start <= block.timestamp &&", "true &&"),
    ("live: end == now refused", "block.timestamp <= s.end &&", "block.timestamp < s.end &&"),
    ("live: end unchecked", "block.timestamp <= s.end &&", "true &&"),
    ("live: 7 days exclusive", "s.end - s.start <= 7 days", "s.end - s.start < 7 days"),
    ("live: 8 days", "s.end - s.start <= 7 days", "s.end - s.start <= 8 days"),
    ("live: ended marker live", "&& s.end - s.start <= 7 days;", "&& true;"),
    ("live: joined by or (1)", "s.start <= block.timestamp && block", "s.start <= block.timestamp || block"),
    ("live: joined by or (2)", "s.end && s.end - s.start", "s.end || s.end - s.start"),
    ("live: wrong key slot", "Session memory s = sessions[key];", "Session memory s = sessions[owner];"),
    ("live: always", "return s.start <= block.timestamp && block.timestamp <= s.end && s.end - s.start <= 7 days;", "return true;"),
]


def main():
    out = os.path.abspath(sys.argv[1])
    here = os.path.dirname(os.path.abspath(__file__))
    work = tempfile.mkdtemp(prefix="prime-seat-mutate-")
    for d in ("src", "test"):
        shutil.copytree(os.path.join(here, d), os.path.join(work, d))
    shutil.copy(os.path.join(here, "foundry.toml"), work)
    os.symlink(os.path.join(here, "lib"), os.path.join(work, "lib"))
    os.chdir(work)
    src = open(SRC).read()
    res = []
    for name, old, new in M:
        if os.environ.get("ONLY") and os.environ["ONLY"] not in name:
            continue
        if src.count(old) != 1:
            res.append((name, f"NOAPPLY({src.count(old)})"))
            print(name, res[-1][1], flush=True)
            continue
        open(SRC, "w").write(src.replace(old, new, 1))
        r = subprocess.run([FORGE, "test"], capture_output=True, text=True)
        o = r.stdout + r.stderr
        st = "SURVIVED" if r.returncode == 0 else ("KILLED(build)" if "Compiler run failed" in o else "KILLED")
        res.append((name, st))
        print(name, st, flush=True)
    shutil.rmtree(work)
    json.dump(res, open(out, "w"), indent=1)
    bad = [n for n, s in res if s.startswith(("SURVIVED", "NOAPPLY"))]
    print(f"{len(res)} mutants, {sum(s.startswith('KILLED') for _, s in res)} killed; open: {bad}")
    sys.exit(1 if bad else 0)


main()
