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
}

contract StubRoles {
    function execTransactionWithRole(address, uint256, bytes calldata, uint8, bytes32, bool) external pure returns (bool) {
        return true;
    }
}

contract PrimeSessionVoteTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    uint256 constant OWNER_PK = 0xA11CE;
    uint256 constant KEY_PK = 0xB0B;
    uint256 constant OTHER_PK = 0xC0DE;
    bytes32 constant ROLE = "movers";
    bytes4 constant MAGIC = 0x20c13b0b;
    bytes4 constant NO = 0xffffffff;

    event Gas(string what, uint256 gas);

    PrimeSession ps;
    address key;
    // 0x1901 | domain separator | SafeTx hash, as Safe 1.4.1 builds it (66 bytes)
    function safeData() internal pure returns (bytes memory) {
        return abi.encodePacked(bytes2(0x1901), keccak256("domain"), keccak256("safeTx"));
    }

    function setUp() public {
        vm.warp(1_800_000_000);
        ps = new PrimeSession(vm.addr(OWNER_PK), IRoles(address(new StubRoles())));
        key = vm.addr(KEY_PK);
    }

    function sign(uint256 pk, bytes32 h) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, h);
        return abi.encodePacked(r, s, v);
    }

    function grantSig(address k, uint256 end, bool vote) internal returns (bytes memory) {
        return sign(OWNER_PK, MessageHashUtils.toEthSignedMessageHash(bytes(ps.grantText(k, end, vote))));
    }

    function grantKey(uint256 end, bool vote) internal {
        ps.grant(key, end, vote, grantSig(key, end, vote));
    }

    function castVote(uint256 pk) internal returns (bytes4) {
        return ps.isValidSignature(safeData(), sign(pk, keccak256(safeData())));
    }

    function test_ownerVotes() public {
        assert(castVote(OWNER_PK) == MAGIC);
    }

    function test_strangerDoesNotVote() public {
        assert(castVote(OTHER_PK) == NO);
        assert(castVote(KEY_PK) == NO);
    }

    function test_voteSessionVotes() public {
        grantKey(block.timestamp + 3600, true);
        assert(castVote(KEY_PK) == MAGIC);
    }

    function test_moveOnlySessionDoesNotVote() public {
        grantKey(block.timestamp + 3600, false);
        assert(castVote(KEY_PK) == NO);
    }

    function test_voteFlagIsBoundByTheOwnerSignature() public {
        uint256 end = block.timestamp + 3600;
        bytes memory moveOnly = grantSig(key, end, false);
        vm.expectRevert(bytes("grant sig"));
        ps.grant(key, end, true, moveOnly);
        assert(castVote(KEY_PK) == NO);
    }

    function test_sessionStopsVotingAtItsEnd() public {
        uint256 end = block.timestamp + 3600;
        grantKey(end, true);
        vm.warp(end);
        assert(castVote(KEY_PK) == MAGIC);
        vm.warp(end + 1);
        assert(castVote(KEY_PK) == NO);
    }

    function test_revokeIsFinalForVotes() public {
        grantKey(block.timestamp + 3600, true);
        grantKey(0, false);
        assert(castVote(KEY_PK) == NO);
        uint256 end = block.timestamp + 3600;
        bytes memory sig = grantSig(key, end, true);
        vm.expectRevert(bytes("grant"));
        ps.grant(key, end, true, sig);
        assert(castVote(KEY_PK) == NO);
    }

    function test_revokeWithVoteFlagStillRevokes() public {
        grantKey(block.timestamp + 3600, true);
        grantKey(0, true);
        assert(castVote(KEY_PK) == NO);
    }

    function test_laterGrantCanDropOrAddTheVoteRight() public {
        grantKey(block.timestamp + 3600, true);
        grantKey(block.timestamp + 7200, false);
        assert(castVote(KEY_PK) == NO);
        grantKey(block.timestamp + 10800, true);
        assert(castVote(KEY_PK) == MAGIC);
    }

    function test_voteSessionStillMoves() public {
        grantKey(block.timestamp + 3600, true);
        bytes32 h = keccak256(abi.encode(address(ps), block.chainid, uint256(0), address(9), uint256(0), keccak256(""), uint8(0), ROLE));
        ps.exec(address(9), 0, "", 0, ROLE, key, sign(KEY_PK, h));
        (, uint120 nonce, bool v) = _s(key);
        assert(nonce == 1 && v);
    }

    function test_oneStorageSlot() public {
        grantKey(block.timestamp + 3600, true);
        bytes32 slot = keccak256(abi.encode(key, uint256(0)));
        uint256 raw = uint256(vm.load(address(ps), slot));
        assert(raw >> 248 == 1);                      // vote byte at the top of the one slot
        assert(uint128(raw) == block.timestamp + 3600); // until at the bottom
        assert(vm.load(address(ps), bytes32(uint256(slot) + 1)) == 0);
    }

    function test_voteIsNotAMoveSignature() public {
        // a move-signature hash and a Safe hash are different preimages; a session key's move signature never passes as a vote
        grantKey(block.timestamp + 3600, true);
        bytes32 h = keccak256(abi.encode(address(ps), block.chainid, uint256(0), address(9), uint256(0), keccak256(""), uint8(0), ROLE));
        assert(ps.isValidSignature(safeData(), sign(KEY_PK, h)) == NO);
    }

    function test_gasTable() public {
        uint256 end = block.timestamp + 3600;
        bytes memory g = grantSig(key, end, true);
        bytes memory data = safeData();
        bytes memory so = sign(OWNER_PK, keccak256(data));
        bytes memory sk = sign(KEY_PK, keccak256(data));
        bytes32 h = keccak256(abi.encode(address(ps), block.chainid, uint256(0), address(9), uint256(0), keccak256(""), uint8(0), ROLE));
        bytes memory m = sign(KEY_PK, h);
        uint256 a = gasleft();
        ps.grant(key, end, true, g);
        emit Gas("grant (vote)", a - gasleft());
        a = gasleft(); ps.exec(address(9), 0, "", 0, ROLE, key, m); emit Gas("first move", a - gasleft());
        a = gasleft(); ps.isValidSignature(data, so); emit Gas("isValidSignature owner (warm)", a - gasleft());
        a = gasleft(); ps.isValidSignature(data, sk); emit Gas("isValidSignature vote session (warm)", a - gasleft());
    }

    function _s(address k) internal view returns (uint128 until, uint120 nonce, bool v) {
        return ps.sessions(k);
    }
}
