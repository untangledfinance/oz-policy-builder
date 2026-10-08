// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

interface IRoles {
    function execTransactionWithRole(address to, uint256 value, bytes calldata data, uint8 op, bytes32 role, bool shouldRevert) external returns (bool);
}

/// One wallet's seat and sessions on a Prime Account (Safe + Zodiac Roles). PrimeSession is the wallet's Roles member and
/// its Safe owner (a contract signature, ERC-1271): its owner votes, and so does a live session key whose grant carries
/// the vote flag. A move-only session key can make the moves the Roles rule allows and never votes.
/// The owner is an EVM address that signs personal_sign (EIP-191) grant text and the raw Safe transaction hash: MetaMask
/// itself, or the NEAR MPC address of a Freighter / Phantom NEAR account (the MPC signs the digest).
contract PrimeSession {
    using Strings for *;

    address public immutable owner;
    IRoles public immutable roles;
    struct Session { uint128 until; uint120 nonce; bool vote; } // until: last valid second, type(uint128).max = revoked; one storage slot
    mapping(address => Session) public sessions;

    /// No zero-owner check is needed: OpenZeppelin's recover never returns the zero address (it reverts instead).
    constructor(address owner_, IRoles roles_) {
        (owner, roles) = (owner_, roles_);
    }

    /// The owner's signature over grantText(key, end, vote) starts or extends a session (at most 7 days) or, with end 0,
    /// ends it for good (until = max: exec and votes refuse it and no later grant can follow).
    function grant(address key, uint256 end, bool vote, bytes calldata sig) external {
        require(ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(bytes(grantText(key, end, vote))), sig) == owner, "grant sig");
        require(end == 0 || (sessions[key].until < end && block.timestamp < end && end <= block.timestamp + 7 days), "grant");
        // forge-lint: disable-next-line(unsafe-typecast)  (a non-zero end passed end <= now + 7 days)
        sessions[key] = Session(end == 0 ? type(uint128).max : uint128(end), sessions[key].nonce, vote);
    }

    /// One move signed by a live session key, submitted by a relayer or by the session key itself.
    function exec(address to, uint256 value, bytes calldata data, uint8 op, bytes32 role, address key, bytes calldata sig) external {
        require(block.timestamp <= sessions[key].until && sessions[key].until <= block.timestamp + 7 days, "session");
        bytes32 h = keccak256(abi.encode(address(this), block.chainid, sessions[key].nonce++, to, value, keccak256(data), op, role));
        require(ECDSA.recover(h, sig) == key, "session sig");
        roles.execTransactionWithRole(to, value, data, op, role, true);
    }

    /// Safe 1.4.1 calls this (legacy ERC-1271, selector 0x20c13b0b) on a contract owner with data = 0x1901 | domain
    /// separator | SafeTx hash; keccak256(data) is the hash wallets already sign for a seat vote. sig is one 65-byte
    /// signature over it, made by the owner or by a live session key whose grant carries the vote flag.
    function isValidSignature(bytes calldata data, bytes calldata sig) external view returns (bytes4) {
        address who = ECDSA.recover(keccak256(data), sig);
        return who == owner || (sessions[who].vote && block.timestamp <= sessions[who].until && sessions[who].until <= block.timestamp + 7 days) ? bytes4(0x20c13b0b) : bytes4(0xffffffff);
    }

    function grantText(address key, uint256 end, bool vote) public view returns (string memory) {
        return string.concat("Prime session\ncontract: ", address(this).toHexString(), "\nsession key: ", key.toHexString(),
            "\nvalid until (unix time): ", end.toString(), "\nnetwork: ", block.chainid.toString(), vote ? "\nallows: moves and the owner's Safe votes" : "\nallows: moves only");
    }
}
