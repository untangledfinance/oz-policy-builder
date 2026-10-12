// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface ISafe {
    function isOwner(address) external view returns (bool);
    function isModuleEnabled(address) external view returns (bool);
}

interface IRoles {
    function execTransactionWithRole(address, uint256, bytes calldata, uint8, bytes32, bool) external returns (bool);
}

/// The seat of one NEAR-routed owner on one Prime Account (Safe + Zodiac Roles). `owner` is the NEAR MPC address
/// that signs grants; it never votes. A live session key votes as the seat only beside a native Safe owner's signature
/// over the same hash, and acts alone only through Roles, never on the Safe, an enabled module or the seat itself.
contract PrimeSeat {
    bytes32 constant GRANT =
        keccak256("PrimeSeatGrant(uint256 chainId,address safe,address seat,address key,uint64 start,uint64 end)");

    address public immutable owner;
    address public immutable safe;
    IRoles public immutable roles;

    struct Session {
        uint64 start;
        uint64 end; // type(uint64).max = ended for good
        uint128 nonce;
    }

    mapping(address => Session) public sessions;

    constructor(address owner_, address safe_, IRoles roles_) {
        (owner, safe, roles) = (owner_, safe_, roles_);
    }

    /// The owner signs a grant (start <= now <= end, at most 7 days, later than the stored end). With end 0 the owner
    /// or the key itself signs an end, which is final.
    function grant(address key, uint64 start, uint64 end, bytes calldata sig) external {
        bytes32 h = keccak256(abi.encode(GRANT, block.chainid, safe, this, key, start, end));
        address who = ECDSA.recover(h, sig);
        require(who == owner || (end == 0 && who == key), "sig");
        Session storage s = sessions[key];
        if (end == 0) {
            s.end = type(uint64).max;
        } else {
            require(start <= block.timestamp && block.timestamp <= end && end - start <= 7 days && end > s.end, "grant");
            (s.start, s.end) = (start, end);
        }
    }

    /// One call through Roles signed by a live session key.
    function exec(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 op,
        bytes32 role,
        address key,
        bytes calldata sig
    ) external {
        require(
            live(key) && op == 0 && to != safe && !ISafe(safe).isModuleEnabled(to) && to != address(this), "refused"
        );
        bytes32 h =
            keccak256(abi.encode(this, block.chainid, sessions[key].nonce++, to, value, keccak256(data), op, role));
        require(ECDSA.recover(h, sig) == key, "sig");
        roles.execTransactionWithRole(to, value, data, op, role, true);
    }

    /// Safe 1.5.0 form. The Safe asks; address 0 (an off-chain eth_call, as the Safe Transaction Service makes) may
    /// read the same answer. sig = a live key's signature over keccak256(abi.encode(seat, h)), then a Safe owner's own
    /// signature over h (65 bytes each).
    function isValidSignature(bytes32 h, bytes calldata sig) public view returns (bytes4) {
        return (msg.sender == safe || msg.sender == address(0))
            && live(ECDSA.recover(keccak256(abi.encode(this, h)), sig[:65]))
            && ISafe(safe).isOwner(ECDSA.recover(h, sig[65:]))
            ? bytes4(0x1626ba7e)
            : bytes4(0xffffffff);
    }

    /// Safe 1.4.1 form: data is 0x1901 | domain separator | SafeTx hash.
    function isValidSignature(bytes calldata data, bytes calldata sig) external view returns (bytes4) {
        return data.length == 66 && bytes2(data) == 0x1901 && isValidSignature(keccak256(data), sig) == 0x1626ba7e
            ? bytes4(0x20c13b0b)
            : bytes4(0xffffffff);
    }

    function live(address key) internal view returns (bool) {
        Session memory s = sessions[key];
        return s.start <= block.timestamp && block.timestamp <= s.end && s.end - s.start <= 7 days;
    }
}
