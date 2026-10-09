// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

interface IRoles {
    function execTransactionWithRole(address to, uint256 value, bytes calldata data, uint8 op, bytes32 role, bool shouldRevert) external returns (bool);
}

/// One wallet's sessions on a Prime Account (Safe + Zodiac Roles). PrimeSession is the wallet's Roles member and never
/// a Safe owner, so a session key can make the moves the Roles rule allows and can never vote as a seat.
/// The owner is an EVM address that signs personal_sign (EIP-191) text: MetaMask itself, or the NEAR MPC address of
/// a Freighter / Phantom NEAR account (the MPC signs the EIP-191 digest).
contract PrimeSession {
    using Strings for *;

    address public immutable owner;
    IRoles public immutable roles;
    struct Session { uint128 until; uint128 nonce; } // until: last valid second, type(uint128).max = revoked; one storage slot
    mapping(address => Session) public sessions;

    /// No zero-owner check is needed: OpenZeppelin's recover never returns the zero address (it reverts instead).
    constructor(address owner_, IRoles roles_) {
        (owner, roles) = (owner_, roles_);
    }

    /// The owner's signature over grantText(key, end) starts or extends a session (at most 7 days) or, with end 0,
    /// ends it for good (until = max: exec refuses it and no later grant can follow).
    function grant(address key, uint256 end, bytes calldata sig) external {
        require(ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(bytes(grantText(key, end))), sig) == owner, "grant sig");
        require(end == 0 || (sessions[key].until < end && block.timestamp < end && end <= block.timestamp + 7 days), "grant");
        // forge-lint: disable-next-line(unsafe-typecast)  (a non-zero end passed end <= now + 7 days)
        sessions[key].until = end == 0 ? type(uint128).max : uint128(end);
    }

    /// One move signed by a live session key, submitted by a relayer or by the session key itself.
    function exec(address to, uint256 value, bytes calldata data, uint8 op, bytes32 role, address key, bytes calldata sig) external {
        require(block.timestamp <= sessions[key].until && sessions[key].until <= block.timestamp + 7 days, "session");
        bytes32 h = keccak256(abi.encode(address(this), block.chainid, sessions[key].nonce++, to, value, keccak256(data), op, role));
        require(ECDSA.recover(h, sig) == key, "session sig");
        roles.execTransactionWithRole(to, value, data, op, role, true);
    }

    function grantText(address key, uint256 end) public view returns (string memory) {
        return string.concat("Prime session\ncontract: ", address(this).toHexString(), "\nsession key: ", key.toHexString(),
            "\nvalid until (unix time): ", end.toString(), "\nnetwork: ", block.chainid.toString());
    }
}
