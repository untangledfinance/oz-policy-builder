// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

interface IRoles {
    function execTransactionWithRole(address to, uint256 value, bytes calldata data, uint8 op, bytes32 role, bool shouldRevert) external returns (bool);
}

/// One wallet's sessions on a Prime Account (Safe + Zodiac Roles). PrimeKey is the wallet's Roles member and never
/// a Safe owner, so a session key can make the moves the Roles rule allows and can never vote as a seat.
/// The owner is an EVM address that signs personal_sign (EIP-191) text: MetaMask itself, or the NEAR MPC address of
/// a Freighter / Phantom NEAR account (the MPC signs the EIP-191 digest).
contract PrimeKey {
    using Strings for *;

    address public immutable owner;
    IRoles public immutable roles;
    mapping(address => uint256) public until; // session key => last valid second; type(uint256).max = revoked
    mapping(address => uint256) public nonce;

    constructor(address owner_, IRoles roles_) {
        require(owner_ != address(0), "owner");
        (owner, roles) = (owner_, roles_);
    }

    /// Starts (or extends) a session, at most 7 days: the owner's signature over grantText(key, end).
    function grant(address key, uint256 end, bytes calldata sig) external {
        require(key != address(0) && until[key] < end && block.timestamp < end && end <= block.timestamp + 7 days, "grant");
        require(byOwner(grantText(key, end), sig), "grant sig");
        until[key] = end;
    }

    /// Ends a session for good: the owner's signature over grantText(key, 0).
    function revoke(address key, bytes calldata sig) external {
        require(byOwner(grantText(key, 0), sig), "revoke");
        until[key] = type(uint256).max;
    }

    /// One move signed by a live session key, submitted by a relayer or by the session key itself.
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

    function byOwner(string memory text, bytes calldata sig) internal view returns (bool) {
        (address a, ECDSA.RecoverError err,) = ECDSA.tryRecover(MessageHashUtils.toEthSignedMessageHash(bytes(text)), sig);
        return err == ECDSA.RecoverError.NoError && a == owner;
    }
}
