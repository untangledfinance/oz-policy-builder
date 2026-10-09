// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Ed25519} from "../lib/Ed25519.sol";

interface IRoles {
    function execTransactionWithRole(address to, uint256 value, bytes calldata data, uint8 op, bytes32 role, bool shouldRevert) external returns (bool);
}

/// One wallet's key to a Prime Account (Safe + Zodiac Roles): its Safe seat (ERC-1271) and its sessions
/// (the Roles member). The wallet only ever signs readable text:
///   kind 0 MetaMask   personal_sign (EIP-191)    owner = address
///   kind 1 Freighter  SEP-53 signMessage         owner = ed25519 key
///   kind 2 Phantom    signMessage (plain text)   owner = ed25519 key
contract PrimeKey {
    using Strings for *;

    uint8 public immutable kind;
    bytes32 public immutable owner;
    IRoles public immutable roles;
    mapping(address => uint256) public until; // session key => last valid second; type(uint256).max = revoked
    mapping(address => uint256) public nonce;

    constructor(uint8 kind_, bytes32 owner_, IRoles roles_) {
        require(kind_ == 0 ? owner_ != 0 && owner_ >> 160 == 0 : kind_ < 3 && !weak(owner_), "owner");
        (kind, owner, roles) = (kind_, owner_, roles_);
    }

    /// Safe seat. Safe 1.4.1 calls this legacy form with the SafeTx pre-image; msg.sender is the Safe.
    function isValidSignature(bytes calldata data, bytes calldata sig) external view returns (bytes4) {
        string memory text = string.concat("Prime approval\nsafe: ", msg.sender.toHexString(), "\nsafe tx: ", uint256(keccak256(data)).toHexString(32));
        return signed(text, sig) ? bytes4(0x20c13b0b) : bytes4(0xffffffff);
    }

    /// Starts (or extends) a session, at most 7 days: the owner's signature over grantText(key, end).
    function grant(address key, uint256 end, bytes calldata sig) external {
        require(key != address(0) && until[key] < end && block.timestamp < end && end <= block.timestamp + 7 days, "grant");
        require(signed(grantText(key, end), sig), "grant sig");
        until[key] = end;
    }

    /// Ends a session for good: the owner's signature over grantText(key, 0).
    function revoke(address key, bytes calldata sig) external {
        require(signed(grantText(key, 0), sig), "revoke");
        until[key] = type(uint256).max;
    }

    /// One move, signed by a live session key; the Roles rule decides what is allowed.
    function exec(address to, uint256 value, bytes calldata data, uint8 op, bytes32 role, address key, bytes calldata sig) external {
        require(block.timestamp <= until[key] && until[key] <= block.timestamp + 7 days, "session");
        bytes32 h = keccak256(abi.encode(address(this), block.chainid, nonce[key]++, to, value, keccak256(data), op, role));
        require(ECDSA.recover(h, sig) == key, "session sig");
        roles.execTransactionWithRole(to, value, data, op, role, true);
    }

    function grantText(address key, uint256 end) public view returns (string memory) {
        return string.concat("Prime session\ncontract: ", address(this).toHexString(), "\nsession key: ", key.toHexString(),
            "\nvalid until (unix time): ", end.toString(), "\nnetwork: ", block.chainid.toString());
    }

    function signed(string memory text, bytes calldata sig) internal view returns (bool) {
        bytes memory m = bytes(text);
        if (kind == 0) {
            (address a, ECDSA.RecoverError err,) = ECDSA.tryRecover(MessageHashUtils.toEthSignedMessageHash(m), sig);
            return err == ECDSA.RecoverError.NoError && a == address(uint160(uint256(owner)));
        }
        if (kind == 1) m = abi.encodePacked(sha256(abi.encodePacked("Stellar Signed Message:\n", m)));
        return sig.length == 64 && Ed25519.verify(owner, bytes32(sig[:32]), bytes32(sig[32:]), m);
    }

    /// Small-order points (forgeable: R = identity, S = 0) and non-canonical y >= p.
    function weak(bytes32 k) internal pure returns (bool) {
        uint256 y;
        for (uint256 i; i < 32; i++) y |= uint256(uint8(k[i])) << (8 * i);
        y &= (1 << 255) - 1;
        (uint256 p, uint256 y8) = (2 ** 255 - 19, 0x7a03ac9277fdc74ec6cc392cfa53202a0f67100d760b3cba4fd84d3d706a17c7);
        return y >= p || y <= 1 || y == p - 1 || y == y8 || y == p - y8;
    }
}
