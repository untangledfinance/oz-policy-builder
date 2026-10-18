// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

interface IRoles {
    function execTransactionWithRole(address to, uint256 value, bytes calldata data, uint8 op, bytes32 role, bool shouldRevert) external returns (bool);
}

/// Variant of PrimeSession in which a vote session cannot vote on Safe governance: its vote signature must carry the
/// Safe transaction's fields, and the vote is refused when the Safe calls itself or its Roles modifier or delegatecalls.
/// One wallet's seat and sessions on a Prime Account (Safe + Zodiac Roles). PrimeSession is the wallet's Roles member and
/// its Safe owner (a contract signature, ERC-1271): its owner votes, and so does a live session key whose grant carries
/// the vote flag. A move-only session key can make the moves the Roles rule allows and never votes.
/// The owner is an EVM address that signs personal_sign (EIP-191) grant text and the raw Safe transaction hash: MetaMask
/// itself, or the NEAR MPC address of a Freighter / Phantom NEAR account (the MPC signs the digest).
contract PrimeSessionNoGov {
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

    bytes32 constant SAFE_TX_TYPEHASH = 0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8;

    /// Safe 1.4.1 calls this (legacy ERC-1271, selector 0x20c13b0b) on a contract owner with data = 0x1901 | domain
    /// separator | SafeTx hash. The owner signs keccak256(data) (sig is 65 bytes). A vote session signs the same hash and
    /// appends the SafeTx fields as 10 words (to, value, keccak256(data), operation, safeTxGas, baseGas, gasPrice, gasToken,
    /// refundReceiver, nonce); they must hash to the SafeTx hash in data, and the transaction must be a plain call that
    /// is not to the calling Safe or to its Roles modifier.
    function isValidSignature(bytes calldata data, bytes calldata sig) external view returns (bytes4) {
        address who = ECDSA.recover(keccak256(data), sig[:65]);
        if (who == owner) return 0x20c13b0b;
        Session memory s = sessions[who];
        if (!(s.vote && block.timestamp <= s.until && s.until <= block.timestamp + 7 days)) return 0xffffffff;
        require(keccak256(bytes.concat(SAFE_TX_TYPEHASH, sig[65:])) == bytes32(data[34:]), "tx fields");
        return address(bytes20(sig[77:97])) != msg.sender && address(bytes20(sig[77:97])) != address(roles) && sig[192] == 0 ? bytes4(0x20c13b0b) : bytes4(0xffffffff);
    }

    function grantText(address key, uint256 end, bool vote) public view returns (string memory) {
        return string.concat("Prime session\ncontract: ", address(this).toHexString(), "\nsession key: ", key.toHexString(),
            "\nvalid until (unix time): ", end.toString(), "\nnetwork: ", block.chainid.toString(), vote ? "\nallows: moves and the owner's Safe votes" : "\nallows: moves only");
    }
}
