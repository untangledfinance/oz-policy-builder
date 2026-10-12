// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PrimeSeat, IRoles} from "../src/PrimeSeat.sol";

// Real Safe 1.4.1 and 1.5.0 L2 contracts on a fork of Base Sepolia. Run with FORK_URL set to a Base Sepolia RPC
// (a public endpoint or a local anvil fork); without it every test returns at once.

interface Vm {
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function addr(uint256) external returns (address);
    function createSelectFork(string calldata) external returns (uint256);
    function envOr(string calldata, string calldata) external returns (string memory);
    function deal(address, uint256) external;
}

interface ISafeFull {
    function VERSION() external view returns (string memory);
    function nonce() external view returns (uint256);
    function getThreshold() external view returns (uint256);
    function isOwner(address) external view returns (bool);
    function getTransactionHash(address, uint256, bytes calldata, uint8, uint256, uint256, uint256, address, address, uint256)
        external
        view
        returns (bytes32);
    function execTransaction(address, uint256, bytes calldata, uint8, uint256, uint256, uint256, address, address, bytes memory)
        external
        payable
        returns (bool);
}

interface IFactory {
    function createProxyWithNonce(address, bytes memory, uint256) external returns (address);
}

contract RolesStub {
    function execTransactionWithRole(address, uint256, bytes calldata, uint8, bytes32, bool) external pure returns (bool) {
        return true;
    }
}

contract PrimeSeatSafeTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    address constant SAFE141 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address constant FACTORY141 = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant FALLBACK141 = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    address constant SAFE150 = 0xEdd160fEBBD92E350D4D398fb636302fccd67C7e;
    address constant FACTORY150 = 0x14F2982D601c9458F93bd70B218933A6f8165e7b;
    address constant FALLBACK150 = 0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4;
    address constant MIGRATION = 0x6439e7ABD8Bb915A5263094784C5CF561c4172AC;
    address constant MULTISEND = 0x9641d764fc13c8B624c04430C7356C1C7C8102e2; // MultiSendCallOnly 1.4.1
    uint256 constant NATIVE_PK = 0xCA11;
    uint256 constant OWNER_A_PK = 0xA11CE; // seat owners (NEAR MPC keys)
    uint256 constant OWNER_B_PK = 0xB0B0;
    uint256 constant KEY_A_PK = 0x5E55A; // session keys
    uint256 constant KEY_B_PK = 0x5E55B;
    uint256 constant STRANGER_PK = 0xBAD;
    bytes32 constant GRANT = keccak256("PrimeSeatGrant(uint256 chainId,address safe,address seat,address key,uint64 start,uint64 end)");
    address constant PAYEE = address(0xD00D);

    address ROLES;
    bool forked;
    ISafeFull safe;
    PrimeSeat seatA;
    PrimeSeat seatB;
    address native;

    struct Part {
        address owner;
        bytes dyn; // empty: a 65-byte EOA signature in `eoa`
        bytes eoa;
    }

    function setUp() public {
        string memory url = vm.envOr("FORK_URL", "");
        forked = bytes(url).length != 0;
        if (forked) vm.createSelectFork(url);
        native = vm.addr(NATIVE_PK);
        ROLES = address(new RolesStub());
    }

    // ---- helpers -------------------------------------------------------------------------------------------------

    function sign(uint256 pk, bytes32 h) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, h);
        return abi.encodePacked(r, s, v);
    }

    function createSafe(address singleton, address factory, address handler) internal {
        address[] memory owners = new address[](1);
        owners[0] = native;
        bytes memory init = abi.encodeWithSignature(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
            owners,
            1,
            address(0),
            "",
            handler,
            address(0),
            0,
            address(0)
        );
        safe = ISafeFull(IFactory(factory).createProxyWithNonce(singleton, init, uint256(keccak256(abi.encode(singleton, block.timestamp)))));
        vm.deal(address(safe), 10 ether);
    }

    function hashOf(address to, uint256 value, bytes memory data, uint8 op) internal view returns (bytes32) {
        return safe.getTransactionHash(to, value, data, op, 0, 0, 0, address(0), address(0), safe.nonce());
    }

    function nativePart(bytes32 h) internal returns (Part memory) {
        return Part(native, "", sign(NATIVE_PK, h));
    }

    // the seat's contract signature: a session key's signature over (seat, h) and a copy of a native owner's over h
    function seatPart(PrimeSeat seat, uint256 keyPk, uint256 nativePk, bytes32 h) internal returns (Part memory) {
        bytes memory dyn = abi.encodePacked(sign(keyPk, keccak256(abi.encode(address(seat), h))), sign(nativePk, h));
        return Part(address(seat), dyn, "");
    }

    function pack(Part[] memory ps) internal pure returns (bytes memory out) {
        for (uint256 i = 0; i < ps.length; i++) {
            for (uint256 j = i + 1; j < ps.length; j++) {
                if (uint160(ps[j].owner) < uint160(ps[i].owner)) (ps[i], ps[j]) = (ps[j], ps[i]);
            }
        }
        bytes memory tail;
        uint256 offset = 65 * ps.length;
        for (uint256 i = 0; i < ps.length; i++) {
            if (ps[i].dyn.length == 0) {
                out = bytes.concat(out, ps[i].eoa);
            } else {
                out = bytes.concat(out, bytes32(uint256(uint160(ps[i].owner))), bytes32(offset), bytes1(0));
                tail = bytes.concat(tail, bytes32(ps[i].dyn.length), ps[i].dyn);
                offset += 32 + ps[i].dyn.length;
            }
        }
        out = bytes.concat(out, tail);
    }

    function run(address to, uint256 value, bytes memory data, uint8 op, Part[] memory ps) internal returns (bool ok, bytes memory ret) {
        (ok, ret) = address(safe).call(
            abi.encodeCall(ISafeFull.execTransaction, (to, value, data, op, 0, 0, 0, address(0), address(0), pack(ps)))
        );
    }

    function two(Part memory a, Part memory b) internal pure returns (Part[] memory ps) {
        ps = new Part[](2);
        (ps[0], ps[1]) = (a, b);
    }

    function one(Part memory a) internal pure returns (Part[] memory ps) {
        ps = new Part[](1);
        ps[0] = a;
    }

    function msgOf(bytes memory ret) internal pure returns (bytes32 m) {
        // the first 32 bytes of an Error(string) payload after the selector, offset and length words are the text
        if (ret.length >= 100) assembly { m := mload(add(ret, 100)) }
    }

    function grantTo(PrimeSeat seat, uint256 ownerPk, uint256 keyPk) internal {
        address key = vm.addr(keyPk);
        uint64 s = uint64(block.timestamp - 120);
        uint64 e = uint64(block.timestamp + 8 hours);
        bytes32 h = keccak256(abi.encode(GRANT, block.chainid, address(safe), address(seat), key, s, e));
        seat.grant(key, s, e, sign(ownerPk, h));
    }

    // nonce 0, signed by the creator alone: add both seats and raise the threshold to 2, in one MultiSend
    function onboard() internal {
        seatA = new PrimeSeat(vm.addr(OWNER_A_PK), address(safe), IRoles(ROLES));
        seatB = new PrimeSeat(vm.addr(OWNER_B_PK), address(safe), IRoles(ROLES));
        bytes memory add1 = abi.encodeWithSignature("addOwnerWithThreshold(address,uint256)", address(seatA), 1);
        bytes memory add2 = abi.encodeWithSignature("addOwnerWithThreshold(address,uint256)", address(seatB), 2);
        bytes memory batch = bytes.concat(
            abi.encodePacked(uint8(0), address(safe), uint256(0), add1.length, add1),
            abi.encodePacked(uint8(0), address(safe), uint256(0), add2.length, add2)
        );
        bytes memory data = abi.encodeWithSignature("multiSend(bytes)", batch);
        bytes32 h = hashOf(MULTISEND, 0, data, 1);
        (bool ok,) = run(MULTISEND, 0, data, 1, one(nativePart(h)));
        assert(ok);
        assert(safe.getThreshold() == 2 && safe.isOwner(address(seatA)) && safe.isOwner(address(seatB)));
        grantTo(seatA, OWNER_A_PK, KEY_A_PK);
        grantTo(seatB, OWNER_B_PK, KEY_B_PK);
    }

    function pay(Part[] memory ps) internal returns (bool ok, bytes memory ret) {
        return run(PAYEE, 1, "", 0, ps);
    }

    function payHash() internal view returns (bytes32) {
        return hashOf(PAYEE, 1, "", 0);
    }

    // ---- the vote shapes, on either Safe version -----------------------------------------------------------------

    function voteShapes() internal {
        accepts();
        refuses();
        governs();
    }

    function accepts() internal {
        bytes32 h = payHash();
        // a native signature plus one session passes
        (bool ok,) = pay(two(nativePart(h), seatPart(seatA, KEY_A_PK, NATIVE_PK, h)));
        assert(ok);
        h = payHash();
        // two sessions pass only because each carries the native owner's signature over the same hash
        (ok,) = pay(two(seatPart(seatA, KEY_A_PK, NATIVE_PK, h), seatPart(seatB, KEY_B_PK, NATIVE_PK, h)));
        assert(ok);
    }

    function refuses() internal {
        bytes32 h = payHash();
        // two sessions with a stranger's co-signature are refused, with the Safe's invalid-contract-signature error
        (bool ok, bytes memory ret) = pay(two(seatPart(seatA, KEY_A_PK, STRANGER_PK, h), seatPart(seatB, KEY_B_PK, STRANGER_PK, h)));
        assert(!ok && msgOf(ret) == bytes32("GS024"));
        // a co-signature over another hash is refused
        (ok,) = pay(two(nativePart(h), seatPart(seatA, KEY_A_PK, NATIVE_PK, keccak256("another transaction"))));
        assert(!ok);
        // a session with no co-signature (65 bytes) reverts
        Part memory bare = Part(address(seatA), sign(KEY_A_PK, keccak256(abi.encode(address(seatA), h))), "");
        (ok,) = pay(two(nativePart(h), bare));
        assert(!ok);
        // the seat owner's own signature, even with a native co-signature, is not a vote
        (ok,) = pay(two(nativePart(h), seatPart(seatA, OWNER_A_PK, NATIVE_PK, h)));
        assert(!ok);
        // a session key of seat B does not vote for seat A
        (ok,) = pay(two(nativePart(h), seatPart(seatA, KEY_B_PK, NATIVE_PK, h)));
        assert(!ok);
        // a proof built for seat A is refused when filed under seat B
        Part memory forA = seatPart(seatA, KEY_A_PK, NATIVE_PK, h);
        forA.owner = address(seatB);
        (ok,) = pay(two(nativePart(h), forA));
        assert(!ok);
        // a lone native signature is below the threshold
        (ok,) = pay(one(nativePart(h)));
        assert(!ok);
    }

    function governs() internal {
        // a session beside the native signature adds an owner: every Safe change takes the same vote shape
        bytes memory add = abi.encodeWithSignature("addOwnerWithThreshold(address,uint256)", address(0xBEEF), 2);
        bytes32 h = hashOf(address(safe), 0, add, 0);
        Part memory s = seatPart(seatA, KEY_A_PK, NATIVE_PK, h);
        (bool ok,) = run(address(safe), 0, add, 0, two(nativePart(h), s));
        assert(ok && safe.isOwner(address(0xBEEF)));
    }

    function test_safe141VoteShapes() public {
        if (!forked) return;
        createSafe(SAFE141, FACTORY141, FALLBACK141);
        assert(keccak256(bytes(safe.VERSION())) == keccak256("1.4.1"));
        onboard();
        voteShapes();
    }

    function test_safe150VoteShapes() public {
        if (!forked) return;
        createSafe(SAFE150, FACTORY150, FALLBACK150);
        assert(keccak256(bytes(safe.VERSION())) == keccak256("1.5.0"));
        onboard();
        voteShapes();
    }

    // a Safe 1.4.1 with seats moves to 1.5.0 by an M-of-N vote, then votes again
    function test_migrationFrom141To150KeepsTheSeatsVoting() public {
        if (!forked) return;
        createSafe(SAFE141, FACTORY141, FALLBACK141);
        onboard();
        bytes32 h = payHash();
        (bool ok,) = pay(two(nativePart(h), seatPart(seatA, KEY_A_PK, NATIVE_PK, h)));
        assert(ok); // 1.4.1 form

        bytes memory data = abi.encodeWithSignature("migrateL2WithFallbackHandler()");
        h = hashOf(MIGRATION, 0, data, 1);
        (ok,) = run(MIGRATION, 0, data, 1, two(nativePart(h), seatPart(seatA, KEY_A_PK, NATIVE_PK, h)));
        assert(ok);
        assert(keccak256(bytes(safe.VERSION())) == keccak256("1.5.0"));

        h = payHash();
        (ok,) = pay(two(nativePart(h), seatPart(seatA, KEY_A_PK, NATIVE_PK, h))); // 1.5.0 form
        assert(ok);
        h = payHash();
        (ok,) = pay(two(seatPart(seatA, KEY_A_PK, NATIVE_PK, h), seatPart(seatB, KEY_B_PK, NATIVE_PK, h)));
        assert(ok);
        h = payHash();
        (ok,) = pay(two(seatPart(seatA, KEY_A_PK, STRANGER_PK, h), seatPart(seatB, KEY_B_PK, STRANGER_PK, h)));
        assert(!ok);
    }

    // after a seat's session ends, the account stops counting it, and an ended seat cannot vote again
    function test_endedSessionStopsVotingOnTheSafe() public {
        if (!forked) return;
        createSafe(SAFE141, FACTORY141, FALLBACK141);
        onboard();
        address key = vm.addr(KEY_A_PK);
        bytes32 endHash = keccak256(abi.encode(GRANT, block.chainid, address(safe), address(seatA), key, uint64(0), uint64(0)));
        seatA.grant(key, 0, 0, sign(KEY_A_PK, endHash));
        bytes32 h = payHash();
        (bool ok,) = pay(two(nativePart(h), seatPart(seatA, KEY_A_PK, NATIVE_PK, h)));
        assert(!ok);
    }

    // a module the M-of-N enabled is a refused exec target, Roles included, on the real Safe. Before it is enabled the
    // same exec reaches Roles, so the refusal comes from the module check.
    function execTo(address m, uint128 nonce) internal returns (bool ok) {
        (, uint64 end,) = seatA.sessions(vm.addr(KEY_A_PK));
        bytes memory sig = sign(
            KEY_A_PK,
            keccak256(abi.encode(address(seatA), block.chainid, nonce, end, m, uint256(0), keccak256(""), uint8(0), bytes32("movers")))
        );
        (ok,) = address(seatA).call(abi.encodeCall(PrimeSeat.exec, (m, 0, "", 0, bytes32("movers"), vm.addr(KEY_A_PK), sig)));
    }

    function test_execRefusesModulesTheSafeEnabled() public {
        if (!forked) return;
        createSafe(SAFE141, FACTORY141, FALLBACK141);
        onboard();
        address[2] memory targets = [address(0x30D), ROLES];
        for (uint256 i = 0; i < 2; i++) {
            address m = targets[i];
            assert(execTo(m, uint128(i))); // control: not enabled yet, the call goes through
            bytes memory en = abi.encodeWithSignature("enableModule(address)", m);
            bytes32 h = hashOf(address(safe), 0, en, 0);
            Part memory s = seatPart(seatA, KEY_A_PK, NATIVE_PK, h);
            (bool ok,) = run(address(safe), 0, en, 0, two(nativePart(h), s));
            assert(ok);
            assert(!execTo(m, uint128(i + 1))); // enabled: refused; the refusal reverts, so the nonce stays at i + 1
        }
    }
}
