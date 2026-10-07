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

    /// No zero-owner check is needed: OpenZeppelin's tryRecover never reports success for the zero address.
    constructor(address owner_, IRoles roles_) {
        (owner, roles) = (owner_, roles_);
    }

    /// The owner's signature over grantText(key, end) starts or extends a session (at most 7 days) or, with end 0,
    /// ends it for good (until = max: exec refuses it and no later grant can follow).
    function grant(address key, uint256 end, bytes calldata sig) external {
        (address a, ECDSA.RecoverError err,) = ECDSA.tryRecover(MessageHashUtils.toEthSignedMessageHash(bytes(grantText(key, end))), sig);
        require(err == ECDSA.RecoverError.NoError && a == owner, "grant sig");
        require(end == 0 || (key != address(0) && until[key] < end && block.timestamp < end && end <= block.timestamp + 7 days), "grant");
        until[key] = end == 0 ? type(uint256).max : end;
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
}
