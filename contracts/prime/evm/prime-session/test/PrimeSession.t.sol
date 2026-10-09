// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PrimeSession, IRoles} from "../src/PrimeSession.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface Vm {
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function addr(uint256) external returns (address);
    function warp(uint256) external;
    function load(address, bytes32) external view returns (bytes32);
    function expectRevert(bytes calldata) external;
    function expectRevert() external;
}

contract StubRoles {
    function execTransactionWithRole(address, uint256, bytes calldata, uint8, bytes32, bool) external pure returns (bool) {
        return true;
    }
}

contract PrimeSessionTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    uint256 constant OWNER_PK = 0xA11CE;
    uint256 constant KEY_PK = 0xB0B;
    bytes32 constant ROLE = "movers";

    event Gas(string what, uint256 gas);

    PrimeSession ps;
    address key;

    function setUp() public {
        vm.warp(1_800_000_000);
        ps = new PrimeSession(vm.addr(OWNER_PK), IRoles(address(new StubRoles())));
        key = vm.addr(KEY_PK);
    }

    function sign(uint256 pk, bytes32 h) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, h);
        return abi.encodePacked(r, s, v);
    }

    function grantSig(address k, uint256 end) internal returns (bytes memory) {
        return sign(OWNER_PK, MessageHashUtils.toEthSignedMessageHash(bytes(ps.grantText(k, end))));
    }

    function moveSig(uint256 n) internal returns (bytes memory) {
        bytes32 h = keccak256(abi.encode(address(ps), block.chainid, n, address(9), uint256(0), keccak256(""), uint8(0), ROLE));
        return sign(KEY_PK, h);
    }

    function move(uint256 n) internal {
        ps.exec(address(9), 0, "", 0, ROLE, key, moveSig(n));
    }

    function test_gasTable() public {
        uint256 end = block.timestamp + 3600;
        bytes memory g = grantSig(key, end);
        uint256 a = gasleft();
        ps.grant(key, end, g);
        emit Gas("grant", a - gasleft());
        for (uint256 n = 0; n < 2; n++) {
            bytes memory s = moveSig(n);
            a = gasleft();
            ps.exec(address(9), 0, "", 0, ROLE, key, s);
            emit Gas(n == 0 ? "first move" : "later move", a - gasleft());
        }
        bytes memory r = grantSig(key, 0);
        a = gasleft();
        ps.grant(key, 0, r);
        emit Gas("revoke", a - gasleft());
    }

    function test_untilAndNonceShareOneSlot() public {
        uint256 end = block.timestamp + 3600;
        ps.grant(key, end, grantSig(key, end));
        move(0);
        move(1);
        (uint128 until, uint128 nonce) = ps.sessions(key);
        require(until == end && nonce == 2, "fields");
        bytes32 slot = keccak256(abi.encode(key, uint256(0))); // owner and roles are immutable, so the mapping sits at slot 0
        require(uint256(vm.load(address(ps), slot)) == (uint256(nonce) << 128) | until, "one slot");
    }

    function test_revokeKeepsNonceAndBlocksMoveAndRegrant() public {
        uint256 end = block.timestamp + 3600;
        ps.grant(key, end, grantSig(key, end));
        move(0);
        ps.grant(key, 0, grantSig(key, 0));
        (uint128 until, uint128 nonce) = ps.sessions(key);
        require(until == type(uint128).max && nonce == 1, "revoked");
        bytes memory s = moveSig(1);
        vm.expectRevert(bytes("session"));
        ps.exec(address(9), 0, "", 0, ROLE, key, s);
        bytes memory g = grantSig(key, end + 60);
        vm.expectRevert(bytes("grant"));
        ps.grant(key, end + 60, g);
    }

    function test_grantRefusals() public {
        uint256 tooLate = block.timestamp + 7 days + 1;
        bytes memory late = grantSig(key, tooLate);
        vm.expectRevert(bytes("grant"));
        ps.grant(key, tooLate, late);
        uint256 past = block.timestamp - 1;
        bytes memory old = grantSig(key, past);
        vm.expectRevert(bytes("grant"));
        ps.grant(key, past, old);
        uint256 end = block.timestamp + 3600;
        bytes memory g = grantSig(key, end);
        bytes memory other = sign(KEY_PK, MessageHashUtils.toEthSignedMessageHash(bytes(ps.grantText(key, end))));
        vm.expectRevert(bytes("grant sig"));
        ps.grant(key, end, other);
        ps.grant(key, end, g);
        bytes memory shorter = grantSig(key, end - 1);
        vm.expectRevert(bytes("grant"));
        ps.grant(key, end - 1, shorter);
    }

    function test_zeroKeyIsAcceptedButNeverUsable() public {
        uint256 end = block.timestamp + 3600;
        ps.grant(address(0), end, grantSig(address(0), end));
        (uint128 until,) = ps.sessions(address(0));
        require(until == end, "stored");
        bytes memory junk = new bytes(65);
        vm.expectRevert(abi.encodeWithSignature("ECDSAInvalidSignature()"));
        ps.exec(address(9), 0, "", 0, ROLE, address(0), junk);
    }

    function test_moveRefusals() public {
        uint256 end = block.timestamp + 3600;
        ps.grant(key, end, grantSig(key, end));
        bytes memory s = moveSig(0);
        ps.exec(address(9), 0, "", 0, ROLE, key, s);
        vm.expectRevert(bytes("session sig"));
        ps.exec(address(9), 0, "", 0, ROLE, key, s);
        vm.warp(end + 1);
        bytes memory s1 = moveSig(1);
        vm.expectRevert(bytes("session"));
        ps.exec(address(9), 0, "", 0, ROLE, key, s1);
    }
}
