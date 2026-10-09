// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PrimeSession, IRoles} from "../src/PrimeSession.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

interface Vm2 {
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function addr(uint256) external returns (address);
    function warp(uint256) external;
    function chainId(uint256) external;
    function expectRevert(bytes calldata) external;
    function expectRevert() external;
}

contract RecordingRoles {
    address public to;
    uint256 public value;
    bytes public data;
    uint8 public op;
    bytes32 public role;
    bool public shouldRevert;
    uint256 public calls;

    function execTransactionWithRole(address t, uint256 v, bytes calldata d, uint8 o, bytes32 r, bool s) external returns (bool) {
        (to, value, data, op, role, shouldRevert) = (t, v, d, o, r, s);
        calls++;
        return true;
    }
}

contract SilentRoles {
    fallback() external {}
}

// Pins every byte of the grant text, the move digest and the call into Roles, using non-zero values everywhere.
contract PrimeSessionBindingTest {
    Vm2 constant vm = Vm2(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    uint256 constant OWNER_PK = 0xA11CE;
    uint256 constant KEY_PK = 0xB0B;

    PrimeSession ps;
    RecordingRoles rr;
    address key;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.chainId(84532);
        rr = new RecordingRoles();
        ps = new PrimeSession(vm.addr(OWNER_PK), IRoles(address(rr)));
        key = vm.addr(KEY_PK);
    }

    function sign(uint256 pk, bytes32 h) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, h);
        return abi.encodePacked(r, s, v);
    }


    function test_grantTextIsExact() public view {
        string memory want = string.concat(
            "Prime session\ncontract: ", Strings.toHexString(address(ps)), "\nsession key: ", Strings.toHexString(key), "\nvalid until (unix time): 1800003600\nnetwork: 84532"
        );
        require(keccak256(bytes(ps.grantText(key, 1_800_003_600))) == keccak256(bytes(want)), "text");
        require(keccak256(bytes(ps.grantText(address(0xBEEF), 7))) == keccak256(bytes(string.concat("Prime session\ncontract: ", Strings.toHexString(address(ps)), "\nsession key: 0x000000000000000000000000000000000000beef\nvalid until (unix time): 7\nnetwork: 84532"))), "text2");
    }

    function test_grantIsEip191AndCallerIndependent() public {
        uint256 end = block.timestamp + 3600;
        bytes memory g = sign(OWNER_PK, MessageHashUtils.toEthSignedMessageHash(bytes(ps.grantText(key, end))));
        ps.grant(key, end, g);
        (uint128 until, uint128 nonce) = ps.sessions(key);
        require(until == end && nonce == 0, "stored");
        require(ps.owner() == vm.addr(OWNER_PK) && address(ps.roles()) == address(rr), "immutables");
        (uint128 u2, uint128 n2) = ps.sessions(vm.addr(OWNER_PK));
        require(u2 == 0 && n2 == 0, "other slots untouched");
    }

    function grantLive(uint256 end) internal {
        ps.grant(key, end, sign(OWNER_PK, MessageHashUtils.toEthSignedMessageHash(bytes(ps.grantText(key, end)))));
    }

    function test_execBindsEveryFieldAndForwardsThem() public {
        grantLive(block.timestamp + 3600);
        address to = address(0xCAFE);
        bytes memory data = hex"a9059cbb00000000000000000000000000000000000000000000000000000000000000ff";
        bytes32 role = bytes32("movers");
        bytes32 h = keccak256(abi.encode(address(ps), block.chainid, uint256(0), to, uint256(5), keccak256(data), uint8(1), role));
        ps.exec(to, 5, data, 1, role, key, sign(KEY_PK, h));
        require(rr.calls() == 1 && rr.to() == to && rr.value() == 5 && keccak256(rr.data()) == keccak256(data), "forwarded");
        require(rr.op() == 1 && rr.role() == role && rr.shouldRevert(), "forwarded2");
        (, uint128 nonce) = ps.sessions(key);
        require(nonce == 1, "nonce");
        // the next digest must use nonce 1 and every other field again
        bytes32 h2 = keccak256(abi.encode(address(ps), block.chainid, uint256(1), to, uint256(5), keccak256(data), uint8(1), role));
        ps.exec(to, 5, data, 1, role, key, sign(KEY_PK, h2));
        (, nonce) = ps.sessions(key);
        require(nonce == 2 && rr.calls() == 2, "second");
    }

    function test_changingAnyFieldBreaksTheSignature() public {
        grantLive(block.timestamp + 3600);
        address to = address(0xCAFE);
        bytes memory data = hex"01";
        bytes32 role = bytes32("movers");
        bytes32 h = keccak256(abi.encode(address(ps), block.chainid, uint256(0), to, uint256(5), keccak256(data), uint8(1), role));
        bytes memory s = sign(KEY_PK, h);
        vm.expectRevert(bytes("session sig"));
        ps.exec(address(0xCAFF), 5, data, 1, role, key, s);
        vm.expectRevert(bytes("session sig"));
        ps.exec(to, 6, data, 1, role, key, s);
        vm.expectRevert(bytes("session sig"));
        ps.exec(to, 5, hex"02", 1, role, key, s);
        vm.expectRevert(bytes("session sig"));
        ps.exec(to, 5, data, 2, role, key, s);
        vm.expectRevert(bytes("session sig"));
        ps.exec(to, 5, data, 1, bytes32("other"), key, s);
        vm.chainId(1);
        vm.expectRevert(bytes("session sig"));
        ps.exec(to, 5, data, 1, role, key, s);
        vm.chainId(84532);
        ps.exec(to, 5, data, 1, role, key, s);
    }

    function test_sessionWindowEdges() public {
        uint256 end = block.timestamp + 7 days;
        grantLive(end);
        address to = address(1);
        bytes32 role = bytes32("r");
        bytes32 h = keccak256(abi.encode(address(ps), block.chainid, uint256(0), to, uint256(0), keccak256(""), uint8(0), role));
        ps.exec(to, 0, "", 0, role, key, sign(KEY_PK, h));
        vm.warp(end);
        bytes32 h1 = keccak256(abi.encode(address(ps), block.chainid, uint256(1), to, uint256(0), keccak256(""), uint8(0), role));
        ps.exec(to, 0, "", 0, role, key, sign(KEY_PK, h1));
        vm.warp(end + 1);
        bytes32 h2 = keccak256(abi.encode(address(ps), block.chainid, uint256(2), to, uint256(0), keccak256(""), uint8(0), role));
        bytes memory s2 = sign(KEY_PK, h2);
        vm.expectRevert(bytes("session"));
        ps.exec(to, 0, "", 0, role, key, s2);
    }

    function test_grantWindowEdges() public {
        uint256 now_ = block.timestamp;
        // end == now is refused, now + 1 is accepted
        bytes memory gNow = sign(OWNER_PK, MessageHashUtils.toEthSignedMessageHash(bytes(ps.grantText(key, now_))));
        vm.expectRevert(bytes("grant"));
        ps.grant(key, now_, gNow);
        grantLive(now_ + 1);
        // equal end refused (until < end is strict), longer accepted, 7 days exactly accepted for a new key, 7 days + 1 refused
        bytes memory gSame = sign(OWNER_PK, MessageHashUtils.toEthSignedMessageHash(bytes(ps.grantText(key, now_ + 1))));
        vm.expectRevert(bytes("grant"));
        ps.grant(key, now_ + 1, gSame);
        grantLive(now_ + 7 days);
        bytes memory gFar = sign(OWNER_PK, MessageHashUtils.toEthSignedMessageHash(bytes(ps.grantText(key, now_ + 7 days + 1))));
        vm.expectRevert(bytes("grant"));
        ps.grant(key, now_ + 7 days + 1, gFar);
    }

    function test_revokeValueAndFinality() public {
        grantLive(block.timestamp + 3600);
        ps.grant(key, 0, sign(OWNER_PK, MessageHashUtils.toEthSignedMessageHash(bytes(ps.grantText(key, 0)))));
        (uint128 until,) = ps.sessions(key);
        require(until == type(uint128).max, "max");
        // a second revoke on a revoked key is accepted
        ps.grant(key, 0, sign(OWNER_PK, MessageHashUtils.toEthSignedMessageHash(bytes(ps.grantText(key, 0)))));
        (until,) = ps.sessions(key);
        require(until == type(uint128).max, "still max");
    }

    function test_revokeNeverGrantedKeyAndWrongSigner() public {
        address other = address(0x1234);
        ps.grant(other, 0, sign(OWNER_PK, MessageHashUtils.toEthSignedMessageHash(bytes(ps.grantText(other, 0)))));
        (uint128 until,) = ps.sessions(other);
        require(until == type(uint128).max, "pre-revoked");
        bytes memory bad = sign(KEY_PK, MessageHashUtils.toEthSignedMessageHash(bytes(ps.grantText(key, 0))));
        vm.expectRevert(bytes("grant sig"));
        ps.grant(key, 0, bad);
    }

    function test_rolesThatReturnNothingMakeExecRevert() public {
        PrimeSession p2 = new PrimeSession(vm.addr(OWNER_PK), IRoles(address(new SilentRoles())));
        uint256 end = block.timestamp + 3600;
        p2.grant(key, end, sign(OWNER_PK, MessageHashUtils.toEthSignedMessageHash(bytes(p2.grantText(key, end)))));
        bytes32 h = keccak256(abi.encode(address(p2), block.chainid, uint256(0), address(1), uint256(0), keccak256(""), uint8(0), bytes32(0)));
        bytes memory s = sign(KEY_PK, h);
        vm.expectRevert();
        p2.exec(address(1), 0, "", 0, bytes32(0), key, s);
    }

    // Chain time never runs backwards; warping back is the only way to put `until` more than 7 days ahead of now.
    function test_execRefusesAnUntilBeyondSevenDaysOfNow() public {
        uint256 t0 = block.timestamp;
        grantLive(t0 + 7 days);
        vm.warp(t0 - 1);
        bytes32 h = keccak256(abi.encode(address(ps), block.chainid, uint256(0), address(1), uint256(0), keccak256(""), uint8(0), bytes32(0)));
        bytes memory s = sign(KEY_PK, h);
        vm.expectRevert(bytes("session"));
        ps.exec(address(1), 0, "", 0, bytes32(0), key, s);
        vm.warp(t0);
        ps.exec(address(1), 0, "", 0, bytes32(0), key, s);
    }
}
