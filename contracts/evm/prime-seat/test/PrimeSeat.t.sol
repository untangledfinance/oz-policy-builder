// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PrimeSeat, IRoles} from "../src/PrimeSeat.sol";

interface Vm {
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function addr(uint256) external returns (address);
    function warp(uint256) external;
    function chainId(uint256) external;
    function load(address, bytes32) external view returns (bytes32);
    function store(address, bytes32, bytes32) external;
    function expectRevert() external;
    function prank(address) external;
}

contract StubSafe {
    mapping(address => bool) public isOwner;
    mapping(address => bool) public isModuleEnabled;

    function setOwner(address a, bool on) external {
        isOwner[a] = on;
    }

    function setModule(address a, bool on) external {
        isModuleEnabled[a] = on;
    }
}

contract StubRoles {
    uint256 public calls;
    address public lastTo;
    uint256 public lastValue;
    bytes public lastData;
    uint8 public lastOp;
    bytes32 public lastRole;
    bool public lastShouldRevert;

    function execTransactionWithRole(address to, uint256 value, bytes calldata data, uint8 op, bytes32 role, bool shouldRevert)
        external
        returns (bool)
    {
        (calls, lastTo, lastValue, lastData, lastOp, lastRole, lastShouldRevert) = (calls + 1, to, value, data, op, role, shouldRevert);
        return true;
    }
}

contract PrimeSeatTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    uint256 constant OWNER_PK = 0xA11CE; // the seat owner (a NEAR MPC key in production)
    uint256 constant KEY_PK = 0xB0B; // a session key
    uint256 constant NATIVE_PK = 0xCA11; // a native Safe owner
    uint256 constant STRANGER_PK = 0xBAD;
    uint256 constant NOW = 1_800_000_000;
    bytes32 constant ROLE = "movers";
    bytes4 constant LEGACY = 0x20c13b0b;
    bytes4 constant MODERN = 0x1626ba7e;
    bytes4 constant NO = 0xffffffff;
    bytes32 constant GRANT = keccak256("PrimeSeatGrant(uint256 chainId,address safe,address seat,address key,uint64 start,uint64 end)");

    StubSafe safe;
    StubRoles roles;
    PrimeSeat seat;
    address key;
    address native;

    function setUp() public {
        vm.warp(NOW);
        safe = new StubSafe();
        roles = new StubRoles();
        seat = new PrimeSeat(vm.addr(OWNER_PK), address(safe), IRoles(address(roles)));
        key = vm.addr(KEY_PK);
        native = vm.addr(NATIVE_PK);
        safe.setOwner(native, true);
        safe.setOwner(address(seat), true);
        safe.setModule(address(roles), true);
    }

    // ---- helpers -------------------------------------------------------------------------------------------------

    function sign(uint256 pk, bytes32 h) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, h);
        return abi.encodePacked(r, s, v);
    }

    function grantHash(PrimeSeat s, address k, uint64 start, uint64 end) internal view returns (bytes32) {
        return keccak256(abi.encode(GRANT, block.chainid, address(safe), address(s), k, start, end));
    }

    function grantAs(uint256 pk, address k, uint64 start, uint64 end) internal {
        seat.grant(k, start, end, sign(pk, grantHash(seat, k, start, end)));
    }

    function begin(uint64 seconds_) internal {
        grantAs(OWNER_PK, key, uint64(NOW - 120), uint64(NOW + seconds_));
    }

    function endAs(uint256 pk) internal {
        grantAs(pk, key, 0, 0);
    }

    function safeData(bytes32 txHash) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes2(0x1901), keccak256("domain"), txHash);
    }

    function proof(PrimeSeat s, uint256 sessionPk, uint256 nativePk, bytes32 h) internal returns (bytes memory) {
        return abi.encodePacked(sign(sessionPk, keccak256(abi.encode(address(s), h))), sign(nativePk, h));
    }

    function modern(bytes32 h, bytes memory sig) internal returns (bytes4) {
        vm.prank(address(safe));
        return seat.isValidSignature(h, sig);
    }

    function revertsModern(bytes32 h, bytes memory sig) internal returns (bool) {
        vm.prank(address(safe));
        (bool ok,) = address(seat).call(abi.encodeWithSignature("isValidSignature(bytes32,bytes)", h, sig));
        return !ok;
    }

    function legacy(bytes memory data, bytes memory sig) internal returns (bytes4) {
        vm.prank(address(safe));
        return seat.isValidSignature(data, sig);
    }

    // the digest carries the end of the key's stored session, so a held-back signature dies with that session
    function execSigEnd(PrimeSeat s, uint256 pk, uint128 nonce, uint64 end, address to, uint256 value, bytes memory data, uint8 op)
        internal
        returns (bytes memory)
    {
        return sign(pk, keccak256(abi.encode(address(s), block.chainid, nonce, end, to, value, keccak256(data), op, ROLE)));
    }

    function execSig(PrimeSeat s, uint256 pk, uint128 nonce, address to, uint256 value, bytes memory data, uint8 op)
        internal
        returns (bytes memory)
    {
        (, uint64 end,) = s.sessions(key);
        return execSigEnd(s, pk, nonce, end, to, value, data, op);
    }

    function exec(address to, uint256 value, bytes memory data, uint8 op) internal {
        (,, uint128 n) = seat.sessions(key);
        bytes memory sig = execSig(seat, KEY_PK, n, to, value, data, op);
        seat.exec(to, value, data, op, ROLE, key, sig);
    }

    function session() internal view returns (uint64 s, uint64 e, uint128 n) {
        return seat.sessions(key);
    }

    function newSeat(address owner_) internal returns (PrimeSeat) {
        PrimeSeat other = new PrimeSeat(owner_, address(safe), IRoles(address(roles)));
        safe.setOwner(address(other), true);
        return other;
    }

    function fails(address target, bytes memory callData) internal returns (bool) {
        (bool ok,) = target.call(callData);
        return !ok;
    }

    function failsGrant(address k, uint64 s, uint64 e, bytes memory sig) internal returns (bool) {
        return fails(address(seat), abi.encodeCall(PrimeSeat.grant, (k, s, e, sig)));
    }

    function failsExec(address to, uint256 value, bytes memory data, uint8 op, address k, bytes memory sig) internal returns (bool) {
        return fails(address(seat), abi.encodeCall(PrimeSeat.exec, (to, value, data, op, ROLE, k, sig)));
    }

    // ---- constructor and shared vectors --------------------------------------------------------------------------

    function test_constructorStoresImmutables() public {
        assert(seat.owner() == vm.addr(OWNER_PK));
        assert(seat.safe() == address(safe));
        assert(address(seat.roles()) == address(roles));
    }

    function test_grantHashMatchesSharedVectors() public {
        vm.chainId(84532);
        bytes32 g = keccak256(
            abi.encode(
                GRANT,
                uint256(84532),
                address(0x164a074F012d24867bB97ba6Dc542bD678B8404C),
                address(0x8dd3231a50339BdCe203fbe24E1a620d47E19DC1),
                address(0xC8A9981F31091870b8AAf1F28caA78E876A82AE4),
                uint64(1791799080),
                uint64(1791827880)
            )
        );
        assert(g == 0x75c874f598219799889d98bf2f7035510b474497d4d04037db3a05fb0823a58f);
        bytes32 e = keccak256(
            abi.encode(
                GRANT,
                uint256(84532),
                address(0xE7fAe20dc15BaF40bD5A6f9435d995C51fe43AFb),
                address(0x9Ede745571ff1934dB38B90124E9c4Aff98488BA),
                address(0xA4d165989CE32119C4100ee29A3bb5F4fFB3C7f2),
                uint64(0),
                uint64(0)
            )
        );
        assert(e == 0xd5a7c248bbfd4783656c6f226818ec7a6d8c53f34eef228a5d174f387125db79);
    }

    // ---- grant ---------------------------------------------------------------------------------------------------

    function test_ownerGrantStartsSession() public {
        begin(8 hours);
        (uint64 s, uint64 e, uint128 n) = session();
        assert(s == NOW - 120 && e == NOW + 8 hours && n == 0);
    }

    function test_sessionIsOneStorageSlot() public {
        begin(8 hours);
        bytes32 slot = keccak256(abi.encode(key, uint256(0)));
        bytes32 want = bytes32(uint256(NOW - 120) | (uint256(NOW + 8 hours) << 64));
        assert(vm.load(address(seat), slot) == want);
    }

    function test_grantRefusesOtherSigners() public {
        uint64 s = uint64(NOW - 120);
        uint64 e = uint64(NOW + 3600);
        assert(failsGrant(key, s, e, sign(STRANGER_PK, grantHash(seat, key, s, e))));
        assert(failsGrant(key, s, e, sign(NATIVE_PK, grantHash(seat, key, s, e))));
        assert(failsGrant(key, s, e, sign(KEY_PK, grantHash(seat, key, s, e)))); // the key cannot start itself
    }

    function test_grantRefusesChangedFields() public {
        uint64 s = uint64(NOW - 120);
        uint64 e = uint64(NOW + 3600);
        bytes memory sig = sign(OWNER_PK, grantHash(seat, key, s, e));
        assert(failsGrant(vm.addr(STRANGER_PK), s, e, sig));
        assert(failsGrant(key, s + 1, e, sig));
        assert(failsGrant(key, s, e + 1, sig));
        seat.grant(key, s, e, sig);
    }

    function test_grantBoundToThisSeat() public {
        PrimeSeat other = newSeat(vm.addr(OWNER_PK));
        uint64 s = uint64(NOW - 120);
        uint64 e = uint64(NOW + 3600);
        bytes memory forOther = sign(OWNER_PK, grantHash(other, key, s, e));
        assert(failsGrant(key, s, e, forOther));
        other.grant(key, s, e, forOther);
    }

    function test_grantBoundToSafeAndChain() public {
        uint64 s = uint64(NOW - 120);
        uint64 e = uint64(NOW + 3600);
        bytes32 otherSafe = keccak256(abi.encode(GRANT, block.chainid, address(0xdead), address(seat), key, s, e));
        assert(failsGrant(key, s, e, sign(OWNER_PK, otherSafe)));
        bytes32 otherChain = keccak256(abi.encode(GRANT, block.chainid + 1, address(safe), address(seat), key, s, e));
        assert(failsGrant(key, s, e, sign(OWNER_PK, otherChain)));
        bytes32 withoutTypehash = keccak256(abi.encode(block.chainid, address(safe), address(seat), key, s, e));
        assert(failsGrant(key, s, e, sign(OWNER_PK, withoutTypehash)));
    }

    function test_grantRefusesFutureStart() public {
        uint64 s = uint64(NOW + 1);
        uint64 e = uint64(NOW + 3600);
        assert(failsGrant(key, s, e, sign(OWNER_PK, grantHash(seat, key, s, e))));
        s = uint64(NOW);
        seat.grant(key, s, e, sign(OWNER_PK, grantHash(seat, key, s, e))); // start == now is live
    }

    function test_grantRefusesEndedWindow() public {
        uint64 s = uint64(NOW - 3600);
        uint64 e = uint64(NOW - 1);
        assert(failsGrant(key, s, e, sign(OWNER_PK, grantHash(seat, key, s, e))));
        e = uint64(NOW);
        seat.grant(key, s, e, sign(OWNER_PK, grantHash(seat, key, s, e))); // end == now is live
    }

    function test_grantWindowIsAtMostSevenDays() public {
        uint64 s = uint64(NOW - 120);
        uint64 e = s + 7 days + 1;
        assert(failsGrant(key, s, e, sign(OWNER_PK, grantHash(seat, key, s, e))));
        e = s + 7 days;
        seat.grant(key, s, e, sign(OWNER_PK, grantHash(seat, key, s, e)));
    }

    function test_grantRefusesEmptyAndReversedWindow() public {
        uint64 s = uint64(NOW);
        assert(failsGrant(key, s + 10, s + 5, sign(OWNER_PK, grantHash(seat, key, s + 10, s + 5))));
        // a start of 0 with a 7-day end is in the past
        assert(failsGrant(key, 0, 7 days, sign(OWNER_PK, grantHash(seat, key, 0, 7 days))));
    }

    function test_grantExtendsOnlyForward() public {
        begin(1 hours);
        uint64 s = uint64(NOW - 60);
        uint64 same = uint64(NOW + 1 hours);
        uint64 shorter = uint64(NOW + 30 minutes);
        uint64 longer = uint64(NOW + 2 hours);
        assert(failsGrant(key, s, same, sign(OWNER_PK, grantHash(seat, key, s, same))));
        assert(failsGrant(key, s, shorter, sign(OWNER_PK, grantHash(seat, key, s, shorter))));
        seat.grant(key, s, longer, sign(OWNER_PK, grantHash(seat, key, s, longer)));
        (uint64 gs, uint64 ge,) = session();
        assert(gs == s && ge == longer);
    }

    function test_extensionKeepsNonce() public {
        begin(1 hours);
        exec(address(7), 0, "", 0);
        uint64 s = uint64(NOW - 60);
        uint64 longer = uint64(NOW + 2 hours);
        seat.grant(key, s, longer, sign(OWNER_PK, grantHash(seat, key, s, longer)));
        (,, uint128 n) = session();
        assert(n == 1);
    }

    // ---- end -----------------------------------------------------------------------------------------------------

    function test_ownerEndsSessionForGood() public {
        begin(8 hours);
        endAs(OWNER_PK);
        assert(failsExec(address(7), 0, "", 0, key, execSig(seat, KEY_PK, 0, address(7), 0, "", 0)));
        (, uint64 e,) = session();
        assert(e == type(uint64).max);
    }

    function test_keyEndsItself() public {
        begin(8 hours);
        endAs(KEY_PK);
        assert(failsExec(address(7), 0, "", 0, key, execSig(seat, KEY_PK, 0, address(7), 0, "", 0)));
    }

    function test_endRefusesStrangersAndOtherKeys() public {
        begin(8 hours);
        assert(failsGrant(key, 0, 0, sign(STRANGER_PK, grantHash(seat, key, 0, 0))));
        assert(failsGrant(key, 0, 0, sign(NATIVE_PK, grantHash(seat, key, 0, 0))));
        // a different key's self-end does not end this key
        address k2 = vm.addr(STRANGER_PK);
        assert(failsGrant(key, 0, 0, sign(STRANGER_PK, grantHash(seat, k2, 0, 0))));
        exec(address(7), 0, "", 0); // still live
    }

    function test_endBoundToThisSeat() public {
        PrimeSeat other = newSeat(vm.addr(OWNER_PK));
        assert(failsGrant(key, 0, 0, sign(OWNER_PK, grantHash(other, key, 0, 0))));
        assert(failsGrant(key, 0, 0, sign(KEY_PK, grantHash(other, key, 0, 0))));
    }

    function test_endIsFinalAndBlocksHeldBackGrant() public {
        uint64 s = uint64(NOW - 120);
        uint64 e = uint64(NOW + 8 hours);
        bytes memory heldBack = sign(OWNER_PK, grantHash(seat, key, s, e)); // signed before the end, not yet filed
        endAs(OWNER_PK);
        assert(failsGrant(key, s, e, heldBack));
        uint64 e2 = uint64(NOW + 9 hours);
        assert(failsGrant(key, s, e2, sign(OWNER_PK, grantHash(seat, key, s, e2)))); // a fresh grant is refused too
    }

    function test_endOfUnusedKeyBlocksItsFutureGrant() public {
        endAs(KEY_PK);
        uint64 s = uint64(NOW - 120);
        uint64 e = uint64(NOW + 3600);
        assert(failsGrant(key, s, e, sign(OWNER_PK, grantHash(seat, key, s, e))));
    }

    function test_endTwiceIsHarmless() public {
        begin(8 hours);
        endAs(OWNER_PK);
        endAs(KEY_PK);
        (, uint64 e,) = session();
        assert(e == type(uint64).max);
    }

    // ---- use-time checks on states a grant cannot store ------------------------------------------------------------

    function inject(uint64 s, uint64 e, uint128 n) internal {
        bytes32 slot = keccak256(abi.encode(key, uint256(0)));
        vm.store(address(seat), slot, bytes32(uint256(s) | (uint256(e) << 64) | (uint256(n) << 128)));
    }

    function usable(uint128 nonce) internal returns (bool execOk, bool voteOk) {
        bytes memory sig = execSig(seat, KEY_PK, nonce, address(7), 0, "", 0);
        execOk = !failsExec(address(7), 0, "", 0, key, sig);
        bytes32 h = keccak256("safe tx 1");
        voteOk = modern(h, proof(seat, KEY_PK, NATIVE_PK, h)) == MODERN;
    }

    function test_useRefusesAWindowOverSevenDays() public {
        inject(uint64(NOW - 120), uint64(NOW - 120 + 7 days), 0);
        (bool execOk, bool voteOk) = usable(0);
        assert(execOk && voteOk); // exactly seven days is live
        inject(uint64(NOW - 120), uint64(NOW - 120 + 7 days + 1), 0);
        (execOk, voteOk) = usable(0);
        assert(!execOk && !voteOk);
    }

    function test_useRefusesAFutureStart() public {
        inject(uint64(NOW), uint64(NOW + 100), 0);
        (bool execOk, bool voteOk) = usable(0);
        assert(execOk && voteOk); // start == now is live
        inject(uint64(NOW + 1), uint64(NOW + 100), 0);
        (execOk, voteOk) = usable(0);
        assert(!execOk && !voteOk);
    }

    function test_nonceHasRoomAboveSixtyFourBits() public {
        uint128 n = uint128(type(uint64).max) + 5;
        inject(uint64(NOW - 120), uint64(NOW + 3600), n);
        (bool execOk,) = usable(n);
        assert(execOk);
        (,, uint128 after_) = session();
        assert(after_ == n + 1);
    }

    // ---- exec ----------------------------------------------------------------------------------------------------

    function test_execCallsRolesAsTheSeat() public {
        begin(8 hours);
        exec(address(7), 3, hex"c0ffee", 0);
        assert(roles.calls() == 1 && roles.lastTo() == address(7) && roles.lastValue() == 3);
        assert(keccak256(roles.lastData()) == keccak256(hex"c0ffee") && roles.lastOp() == 0);
        assert(roles.lastRole() == ROLE && roles.lastShouldRevert());
        (,, uint128 n) = session();
        assert(n == 1);
    }

    function test_execRefusesDeadKeys() public {
        assert(failsExec(address(7), 0, "", 0, key, execSig(seat, KEY_PK, 0, address(7), 0, "", 0))); // never granted
        begin(1 hours);
        bytes memory sig = execSig(seat, KEY_PK, 0, address(7), 0, "", 0);
        vm.warp(NOW + 1 hours);
        seatExec(sig); // end == now is live
        vm.warp(NOW + 1 hours + 1);
        assert(failsExec(address(7), 0, "", 0, key, execSig(seat, KEY_PK, 1, address(7), 0, "", 0))); // ended
    }

    function seatExec(bytes memory sig) internal {
        seat.exec(address(7), 0, "", 0, ROLE, key, sig);
    }

    function test_execRefusesReplay() public {
        begin(8 hours);
        bytes memory sig = execSig(seat, KEY_PK, 0, address(7), 0, "", 0);
        seatExec(sig);
        assert(failsExec(address(7), 0, "", 0, key, sig));
    }

    function test_execBindsEveryField() public {
        begin(8 hours);
        bytes memory sig = execSig(seat, KEY_PK, 0, address(7), 5, hex"01", 0);
        assert(failsExec(address(8), 5, hex"01", 0, key, sig));
        assert(failsExec(address(7), 6, hex"01", 0, key, sig));
        assert(failsExec(address(7), 5, hex"02", 0, key, sig));
        assert(fails(address(seat), abi.encodeCall(PrimeSeat.exec, (address(7), 5, hex"01", 0, bytes32("other"), key, sig))));
        seat.exec(address(7), 5, hex"01", 0, ROLE, key, sig);
    }

    function test_execBindsSeatAndChain() public {
        begin(8 hours);
        PrimeSeat other = newSeat(vm.addr(OWNER_PK));
        other.grant(key, uint64(NOW - 120), uint64(NOW + 3600), sign(OWNER_PK, grantHash(other, key, uint64(NOW - 120), uint64(NOW + 3600))));
        bytes memory forOther = execSig(other, KEY_PK, 0, address(7), 0, "", 0);
        assert(failsExec(address(7), 0, "", 0, key, forOther));
        bytes memory otherChain = sign(KEY_PK, keccak256(abi.encode(address(seat), block.chainid + 1, uint128(0), uint64(NOW + 8 hours), address(7), uint256(0), keccak256(""), uint8(0), ROLE)));
        assert(failsExec(address(7), 0, "", 0, key, otherChain));
    }

    function test_execRequiresTheKeysOwnSignature() public {
        begin(8 hours);
        bytes memory byStranger = execSig(seat, STRANGER_PK, 0, address(7), 0, "", 0);
        assert(failsExec(address(7), 0, "", 0, key, byStranger));
        bytes memory byOwner = execSig(seat, OWNER_PK, 0, address(7), 0, "", 0);
        assert(failsExec(address(7), 0, "", 0, key, byOwner));
    }

    function test_execRefusesTheSafeRolesAndSeatAsTarget() public {
        begin(8 hours);
        assert(failsExec(address(safe), 0, "", 0, key, execSig(seat, KEY_PK, 0, address(safe), 0, "", 0)));
        assert(failsExec(address(roles), 0, "", 0, key, execSig(seat, KEY_PK, 0, address(roles), 0, "", 0)));
        assert(failsExec(address(seat), 0, "", 0, key, execSig(seat, KEY_PK, 0, address(seat), 0, "", 0)));
        assert(roles.calls() == 0);
        exec(address(7), 0, "", 0); // other targets pass; nonce 0 was not spent by the refusals
        assert(roles.calls() == 1);
    }

    // a seat the Safe no longer lists as an owner cannot exec, and it works again once the Safe lists it
    function test_execRefusesASeatThatIsNoLongerAnOwner() public {
        begin(8 hours);
        exec(address(7), 0, "", 0); // control: a current owner's seat goes through
        assert(roles.calls() == 1);
        safe.setOwner(address(seat), false);
        assert(failsExec(address(7), 0, "", 0, key, execSig(seat, KEY_PK, 1, address(7), 0, "", 0)));
        assert(roles.calls() == 1);
        (,, uint128 n) = session();
        assert(n == 1); // the refusal reverts, so the nonce stays
        safe.setOwner(address(seat), true);
        exec(address(7), 0, "", 0);
        assert(roles.calls() == 2);
    }

    function test_execRefusesEveryEnabledModule() public {
        begin(8 hours);
        address module = address(0x30D);
        safe.setModule(module, true);
        assert(failsExec(module, 0, "", 0, key, execSig(seat, KEY_PK, 0, module, 0, "", 0)));
        safe.setModule(module, false);
        exec(module, 0, "", 0); // the same target passes while the Safe has not enabled it
        assert(roles.calls() == 1);
    }

    function test_heldBackExecDiesWithItsSession() public {
        begin(1 hours);
        bytes memory held = execSig(seat, KEY_PK, 0, address(7), 0, "", 0); // signed in the first session, held back
        vm.warp(NOW + 1 hours + 10); // the session ends by time
        assert(failsExec(address(7), 0, "", 0, key, held));
        uint64 s = uint64(NOW + 1 hours);
        uint64 e = uint64(NOW + 9 hours);
        seat.grant(key, s, e, sign(OWNER_PK, grantHash(seat, key, s, e))); // the owner grants the same key again
        assert(failsExec(address(7), 0, "", 0, key, held)); // the held signature does not come back to life
        assert(roles.calls() == 0);
        exec(address(7), 0, "", 0); // a signature made in the new session works
        assert(roles.calls() == 1);
    }

    function test_extensionRetiresSignaturesMadeBeforeIt() public {
        begin(1 hours);
        bytes memory before = execSig(seat, KEY_PK, 0, address(7), 0, "", 0);
        uint64 s = uint64(NOW - 60);
        uint64 e = uint64(NOW + 2 hours);
        seat.grant(key, s, e, sign(OWNER_PK, grantHash(seat, key, s, e)));
        assert(failsExec(address(7), 0, "", 0, key, before));
        exec(address(7), 0, "", 0);
    }

    function test_execRefusesMultiSendAsADelegatecall() public {
        begin(8 hours);
        address multiSend = address(0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526);
        assert(failsExec(multiSend, 0, hex"8d80ff0a", 1, key, execSig(seat, KEY_PK, 0, multiSend, 0, hex"8d80ff0a", 1)));
        assert(roles.calls() == 0);
    }

    function test_execRefusesDelegatecall() public {
        begin(8 hours);
        assert(failsExec(address(7), 0, "", 1, key, execSig(seat, KEY_PK, 0, address(7), 0, "", 1)));
        assert(failsExec(address(7), 0, "", 2, key, execSig(seat, KEY_PK, 0, address(7), 0, "", 2)));
        assert(roles.calls() == 0);
    }

    // ---- ERC-1271: both forms ------------------------------------------------------------------------------------

    function test_sessionVoteWithNativeCosignPassesBothForms() public {
        begin(8 hours);
        bytes memory data = safeData(keccak256("safe tx 1"));
        bytes32 h = keccak256(data); // the hash Safe 1.4.1 and 1.5.0 both ask a contract owner about
        bytes memory sig = proof(seat, KEY_PK, NATIVE_PK, h);
        assert(modern(h, sig) == MODERN);
        assert(legacy(data, sig) == LEGACY);
    }

    function test_voteRefusesAClaimOfAnotherHashInEitherPart() public {
        begin(8 hours);
        bytes32 h = keccak256("safe tx 1");
        bytes32 other = keccak256("safe tx 2");
        bytes memory nativeOverOther = abi.encodePacked(sign(KEY_PK, keccak256(abi.encode(address(seat), h))), sign(NATIVE_PK, other));
        assert(modern(h, nativeOverOther) == NO);
        bytes memory sessionOverOther = abi.encodePacked(sign(KEY_PK, keccak256(abi.encode(address(seat), other))), sign(NATIVE_PK, h));
        assert(modern(h, sessionOverOther) == NO);
        bytes memory sessionOverBareHash = abi.encodePacked(sign(KEY_PK, h), sign(NATIVE_PK, h));
        assert(modern(h, sessionOverBareHash) == NO);
    }

    function test_sessionAloneIsRefused() public {
        begin(8 hours);
        bytes32 h = keccak256("safe tx 1");
        bytes memory only = sign(KEY_PK, keccak256(abi.encode(address(seat), h)));
        assert(revertsModern(h, only));
    }

    function test_nativeSignatureTwiceIsRefusedWithoutASessionKey() public {
        bytes32 h = keccak256("safe tx 1");
        bytes memory sig = abi.encodePacked(sign(NATIVE_PK, h), sign(NATIVE_PK, h));
        assert(modern(h, sig) == NO);
    }

    function test_ownerSignatureAloneIsNotAVote() public {
        // the seat's owner key (an MPC key that signs grants) never votes, with or without a session
        begin(8 hours);
        bytes32 h = keccak256("safe tx 1");
        assert(modern(h, proof(seat, OWNER_PK, NATIVE_PK, h)) == NO);
    }

    function test_cosignerMustBeASafeOwner() public {
        begin(8 hours);
        bytes32 h = keccak256("safe tx 1");
        assert(modern(h, proof(seat, KEY_PK, STRANGER_PK, h)) == NO);
        assert(modern(h, proof(seat, KEY_PK, NATIVE_PK, h)) == MODERN);
        safe.setOwner(native, false);
        assert(modern(h, proof(seat, KEY_PK, NATIVE_PK, h)) == NO);
    }

    function test_deadKeysDoNotVote() public {
        bytes32 h = keccak256("safe tx 1");
        bytes memory sig = proof(seat, KEY_PK, NATIVE_PK, h);
        assert(modern(h, sig) == NO); // never granted
        begin(1 hours);
        assert(modern(h, sig) == MODERN);
        vm.warp(NOW + 1 hours + 1);
        assert(modern(h, sig) == NO); // ended
        vm.warp(NOW);
        endAs(OWNER_PK);
        assert(modern(h, sig) == NO); // revoked
    }

    function test_sessionSignatureNamesTheSeat() public {
        // one key granted on two seats of the same Safe: a proof made for one is refused by the other
        PrimeSeat other = newSeat(vm.addr(STRANGER_PK));
        begin(8 hours);
        uint64 s = uint64(NOW - 120);
        uint64 e = uint64(NOW + 8 hours);
        other.grant(key, s, e, sign(STRANGER_PK, grantHash(other, key, s, e)));
        bytes32 h = keccak256("safe tx 1");
        bytes memory forSeat = proof(seat, KEY_PK, NATIVE_PK, h);
        assert(modern(h, forSeat) == MODERN);
        vm.prank(address(safe));
        assert(other.isValidSignature(h, forSeat) == NO);
        bytes memory forOther = proof(other, KEY_PK, NATIVE_PK, h);
        assert(modern(h, forOther) == NO);
    }

    function test_addressZeroReadsTheSameAnswerAndChangesNothing() public {
        begin(8 hours);
        bytes memory data = safeData(keccak256("safe tx 1"));
        bytes32 h = keccak256(data);
        bytes memory good = proof(seat, KEY_PK, NATIVE_PK, h);
        bytes32 slot = keccak256(abi.encode(key, uint256(0)));
        bytes32 before = vm.load(address(seat), slot);
        bytes memory nativeOnly = abi.encodePacked(sign(STRANGER_PK, keccak256(abi.encode(address(seat), h))), sign(NATIVE_PK, h));

        // an off-chain eth_call has no sender; the node runs it as address 0, and the call is a static call
        vm.prank(address(0));
        (bool ok, bytes memory ret) = address(seat).staticcall(abi.encodeWithSignature("isValidSignature(bytes32,bytes)", h, good));
        assert(ok && bytes4(abi.decode(ret, (bytes32))) == MODERN);
        vm.prank(address(0));
        (ok, ret) = address(seat).staticcall(abi.encodeWithSignature("isValidSignature(bytes,bytes)", data, good));
        assert(ok && bytes4(abi.decode(ret, (bytes32))) == LEGACY);

        // the proof still has to hold: a stranger's key part, or no native part, is refused
        vm.prank(address(0));
        (ok, ret) = address(seat).staticcall(abi.encodeWithSignature("isValidSignature(bytes32,bytes)", h, nativeOnly));
        assert(ok && bytes4(abi.decode(ret, (bytes32))) == NO);
        vm.prank(address(0));
        (ok,) = address(seat).staticcall(abi.encodeWithSignature("isValidSignature(bytes32,bytes)", h, sign(KEY_PK, keccak256(abi.encode(address(seat), h)))));
        assert(!ok);

        // any other caller is refused, and nothing in the seat's storage moved
        vm.prank(address(0xBEEF));
        (ok, ret) = address(seat).staticcall(abi.encodeWithSignature("isValidSignature(bytes32,bytes)", h, good));
        assert(ok && bytes4(abi.decode(ret, (bytes32))) == NO);
        assert(vm.load(address(seat), slot) == before);
    }

    function test_onlyTheSafeMayAsk() public {
        begin(8 hours);
        bytes32 h = keccak256("safe tx 1");
        bytes memory sig = proof(seat, KEY_PK, NATIVE_PK, h);
        assert(seat.isValidSignature(h, sig) == NO);
        bytes memory data = safeData(keccak256("safe tx 1"));
        bytes memory dsig = proof(seat, KEY_PK, NATIVE_PK, keccak256(data));
        assert(seat.isValidSignature(data, dsig) == NO);
        vm.prank(address(0xBEEF));
        assert(seat.isValidSignature(data, dsig) == NO);
        assert(legacy(data, dsig) == LEGACY);
    }

    function legacyProof(bytes memory data) internal returns (bytes memory) {
        return proof(seat, KEY_PK, NATIVE_PK, keccak256(data));
    }

    function test_legacyFormRequiresTheSafeEncoding() public {
        begin(8 hours);
        bytes32 txHash = keccak256("safe tx 1");
        bytes memory data = safeData(txHash);
        assert(legacy(data, legacyProof(data)) == LEGACY);

        bytes memory wrongSecondByte = safeData(txHash);
        wrongSecondByte[1] = 0x02;
        assert(legacy(wrongSecondByte, legacyProof(wrongSecondByte)) == NO);
        bytes memory wrongFirstByte = safeData(txHash);
        wrongFirstByte[0] = 0x18;
        assert(legacy(wrongFirstByte, legacyProof(wrongFirstByte)) == NO);
        bytes memory longer = abi.encodePacked(safeData(txHash), bytes1(0x00));
        assert(legacy(longer, legacyProof(longer)) == NO);
        bytes memory shorter = new bytes(65);
        for (uint256 i = 0; i < 65; i++) {
            shorter[i] = data[i];
        }
        assert(legacy(shorter, legacyProof(shorter)) == NO);
    }

    function test_grantPreimageAsDataIsRefused() public {
        // Safe 1.4.1 hands `data` to a contract owner unchecked when an integrator calls checkSignatures directly; with
        // data set to a grant preimage, keccak256(data) is a grant hash that a native owner might have signed.
        begin(8 hours);
        uint64 s = uint64(NOW - 120);
        uint64 e = uint64(NOW + 3600);
        bytes memory preimage = abi.encode(GRANT, block.chainid, address(safe), address(seat), key, s, e);
        bytes32 h = keccak256(preimage);
        assert(h == grantHash(seat, key, s, e));
        assert(legacy(preimage, proof(seat, KEY_PK, NATIVE_PK, h)) == NO);
    }

    function test_malformedSignaturesRevert() public {
        begin(8 hours);
        bytes32 h = keccak256("safe tx 1");
        bytes memory good = proof(seat, KEY_PK, NATIVE_PK, h);
        bytes memory shortSig = new bytes(129);
        bytes memory longSig = abi.encodePacked(good, bytes1(0x00));
        bytes memory zeros = new bytes(130);
        bytes memory empty = "";
        bytes[4] memory bad = [shortSig, longSig, zeros, empty];
        for (uint256 i = 0; i < bad.length; i++) {
            assert(revertsModern(h, bad[i]));
        }
        assert(modern(h, good) == MODERN);
    }

    function test_selectorsAreTheTwoErc1271Forms() public view {
        assert(bytes4(keccak256("isValidSignature(bytes32,bytes)")) == MODERN);
        assert(bytes4(keccak256("isValidSignature(bytes,bytes)")) == LEGACY);
    }
}
