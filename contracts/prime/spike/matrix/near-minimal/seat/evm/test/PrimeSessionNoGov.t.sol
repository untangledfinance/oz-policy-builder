// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PrimeSessionNoGov, IRoles} from "../src/PrimeSessionNoGov.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface Vm {
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function addr(uint256) external returns (address);
    function warp(uint256) external;
    function expectRevert(bytes calldata) external;
}

contract PrimeSessionNoGovTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    uint256 constant OWNER_PK = 0xA11CE;
    uint256 constant KEY_PK = 0xB0B;
    bytes32 constant TYPEHASH = 0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8;
    bytes4 constant MAGIC = 0x20c13b0b;
    bytes4 constant NO = 0xffffffff;
    address constant ROLES = address(0xB01E5);
    address constant TOKEN = address(0x70CE);

    event Gas(string what, uint256 gas);

    PrimeSessionNoGov ps;
    address key;

    function setUp() public {
        vm.warp(1_800_000_000);
        ps = new PrimeSessionNoGov(vm.addr(OWNER_PK), IRoles(ROLES));
        key = vm.addr(KEY_PK);
    }

    function sign(uint256 pk, bytes32 h) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, h);
        return abi.encodePacked(r, s, v);
    }

    function grantKey(bool vote) internal {
        uint256 end = block.timestamp + 3600;
        ps.grant(key, end, vote, sign(OWNER_PK, MessageHashUtils.toEthSignedMessageHash(bytes(ps.grantText(key, end, vote)))));
    }

    // The ten words of a SafeTx and the 66 bytes the Safe passes to a contract owner.
    function words(address to, uint8 op) internal pure returns (bytes memory) {
        return abi.encode(to, uint256(0), keccak256("calldata"), op, uint256(0), uint256(0), uint256(0), address(0), address(0), uint256(7));
    }

    function dataFor(bytes memory w) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes2(0x1901), keccak256("domain"), keccak256(bytes.concat(TYPEHASH, w)));
    }

    function session(bytes memory data, bytes memory w) internal returns (bytes memory) {
        return bytes.concat(sign(KEY_PK, keccak256(data)), w);
    }

    function check(address to, uint8 op) internal returns (bytes4) {
        bytes memory w = words(to, op);
        bytes memory d = dataFor(w);
        return ps.isValidSignature(d, session(d, w));
    }

    function test_voteSessionVotesOnAPlainCall() public {
        grantKey(true);
        assert(check(TOKEN, 0) == MAGIC);
    }

    function test_refusesATransactionToTheSafe() public {
        grantKey(true);
        assert(check(address(this), 0) == NO); // this test contract is the caller, standing in for the Safe
    }

    function test_refusesATransactionToRoles() public {
        grantKey(true);
        assert(check(ROLES, 0) == NO);
    }

    function test_refusesADelegatecall() public {
        grantKey(true);
        assert(check(TOKEN, 1) == NO);
    }

    function test_refusesFieldsThatDoNotMatchTheHash() public {
        grantKey(true);
        bytes memory d = dataFor(words(TOKEN, 0));
        bytes memory lie = words(address(0xBEEF), 0);
        bytes memory sig = session(d, lie);
        vm.expectRevert(bytes("tx fields"));
        ps.isValidSignature(d, sig);
    }

    function test_refusesAVoteWithoutFields() public {
        grantKey(true);
        bytes memory d = dataFor(words(TOKEN, 0));
        bytes memory sig = sign(KEY_PK, keccak256(d));
        vm.expectRevert(bytes("tx fields"));
        ps.isValidSignature(d, sig);
    }

    function test_refusesAMessageHash() public {
        grantKey(true);
        bytes memory d = abi.encodePacked(bytes2(0x1901), keccak256("domain"), keccak256("a SafeMessage struct hash"));
        bytes memory sig = session(d, words(TOKEN, 0));
        vm.expectRevert(bytes("tx fields"));
        ps.isValidSignature(d, sig);
    }

    function test_moveOnlySessionStillRefused() public {
        grantKey(false);
        assert(check(TOKEN, 0) == NO);
    }

    function test_ownerStillVotesOnGovernance() public {
        bytes memory d = dataFor(words(address(this), 1));
        assert(ps.isValidSignature(d, sign(OWNER_PK, keccak256(d))) == MAGIC);
    }

    function test_gas() public {
        grantKey(true);
        bytes memory w = words(TOKEN, 0);
        bytes memory d = dataFor(w);
        bytes memory s = session(d, w);
        bytes memory o = sign(OWNER_PK, keccak256(d));
        uint256 a = gasleft(); ps.isValidSignature(d, o); emit Gas("owner", a - gasleft());
        a = gasleft(); ps.isValidSignature(d, s); emit Gas("vote session with fields", a - gasleft());
    }
}
