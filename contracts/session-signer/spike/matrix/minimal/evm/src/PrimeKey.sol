// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ed25519} from "../lib/Ed25519.sol";

interface IRoles {
    function execTransactionWithRole(address to, uint256 value, bytes calldata data, uint8 operation, bytes32 roleKey, bool shouldRevert)
        external
        returns (bool);
}

/// One wallet's key to a Prime Account (Safe + Zodiac Roles): its Safe seat (ERC-1271) and its sessions
/// (the Roles member). The wallet only ever signs readable text:
///   kind 0 MetaMask   personal_sign (EIP-191)    owner = address
///   kind 1 Freighter  SEP-53 signMessage         owner = ed25519 key
///   kind 2 Phantom    signMessage (plain text)   owner = ed25519 key
contract PrimeKey {
    uint8 public immutable kind;
    bytes32 public immutable owner;
    IRoles public immutable roles;
    mapping(address => uint256) public until; // session key => last valid second (0: none or revoked)
    mapping(address => bool) public revoked;
    mapping(address => uint256) public nonce;

    constructor(uint8 kind_, bytes32 owner_, IRoles roles_) {
        require(kind_ == 0 ? owner_ != 0 && owner_ >> 160 == 0 : kind_ < 3 && !weak(owner_), "owner");
        (kind, owner, roles) = (kind_, owner_, roles_);
    }

    /// Safe seat. Safe 1.4.1 calls this legacy form with the SafeTx pre-image; msg.sender is the Safe.
    function isValidSignature(bytes calldata data, bytes calldata sig) external view returns (bytes4) {
        string memory text = string.concat("Prime approval\nsafe: ", toHex(abi.encodePacked(msg.sender)), "\nsafe tx: ", toHex(abi.encodePacked(keccak256(data))));
        return signed(text, sig) ? bytes4(0x20c13b0b) : bytes4(0xffffffff);
    }

    /// Starts (or extends) a session: the owner's signature over grantText(key, end). Anyone may submit it.
    function grant(address key, uint256 end, bytes calldata sig) external {
        require(key != address(0) && until[key] < end && block.timestamp < end && end <= block.timestamp + 7 days, "grant");
        require(!revoked[key] && signed(grantText(key, end), sig), "grant sig");
        until[key] = end;
    }

    /// Ends a session for good: the owner's signature over grantText(key, 0).
    function revoke(address key, bytes calldata sig) external {
        require(signed(grantText(key, 0), sig), "revoke");
        (revoked[key], until[key]) = (true, 0);
    }

    /// One move, signed by a live session key; the Roles rule decides what is allowed.
    function exec(address to, uint256 value, bytes calldata data, uint8 operation, bytes32 roleKey, address key, bytes calldata sig) external {
        require(block.timestamp <= until[key], "session");
        bytes32 h = keccak256(abi.encode(address(this), block.chainid, nonce[key]++, to, value, keccak256(data), operation, roleKey));
        require(recover(h, sig) == key, "session sig");
        roles.execTransactionWithRole(to, value, data, operation, roleKey, true);
    }

    function grantText(address key, uint256 end) public view returns (string memory) {
        return string.concat("Prime session\ncontract: ", toHex(abi.encodePacked(address(this))), "\nsession key: ", toHex(abi.encodePacked(key)),
            "\nvalid until (unix time): ", dec(end), "\nnetwork: ", dec(block.chainid));
    }

    function signed(string memory text, bytes calldata sig) internal view returns (bool) {
        bytes memory m = bytes(text);
        if (kind == 0) return recover(keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n", dec(m.length), m)), sig) == address(uint160(uint256(owner)));
        if (sig.length != 64) return false;
        if (kind == 1) m = abi.encodePacked(sha256(abi.encodePacked("Stellar Signed Message:\n", m)));
        return Ed25519.verify(owner, bytes32(sig[:32]), bytes32(sig[32:]), m);
    }

    function recover(bytes32 h, bytes calldata sig) internal pure returns (address a) {
        if (sig.length != 65 || uint256(bytes32(sig[32:64])) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        a = ecrecover(h, uint8(sig[64]) < 27 ? uint8(sig[64]) + 27 : uint8(sig[64]), bytes32(sig[:32]), bytes32(sig[32:64]));
    }

    /// Small-order points (forgeable: R = identity, S = 0) and non-canonical y >= p.
    function weak(bytes32 k) internal pure returns (bool) {
        uint256 y;
        for (uint256 i; i < 32; i++) y |= uint256(uint8(k[i])) << (8 * i);
        y &= (1 << 255) - 1;
        uint256 p = 2 ** 255 - 19;
        uint256 y8 = 0x7a03ac9277fdc74ec6cc392cfa53202a0f67100d760b3cba4fd84d3d706a17c7;
        return y >= p || y <= 1 || y == p - 1 || y == y8 || y == p - y8;
    }

    function toHex(bytes memory b) internal pure returns (string memory) {
        bytes16 d = "0123456789abcdef";
        bytes memory o = new bytes(2 + 2 * b.length);
        (o[0], o[1]) = ("0", "x");
        for (uint256 i; i < b.length; i++) {
            o[2 + 2 * i] = d[uint8(b[i]) >> 4];
            o[3 + 2 * i] = d[uint8(b[i]) & 15];
        }
        return string(o);
    }

    function dec(uint256 v) internal pure returns (string memory s) {
        if (v == 0) return "0";
        for (; v > 0; v /= 10) s = string.concat(string(abi.encodePacked(bytes1(uint8(48 + v % 10)))), s);
    }
}
