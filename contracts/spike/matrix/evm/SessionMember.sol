// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IRoles {
    function execTransactionWithRole(address to, uint256 value, bytes calldata data, uint8 operation, bytes32 roleKey, bool shouldRevert)
        external
        returns (bool);
}

/// A Prime Account mover on EVM: the Zodiac Roles member that a short-lived session key acts through.
///
/// The owner wallet grants a session once, off chain, by signing EIP-712 `PrimeSession` naming THIS
/// member, the session key, `validUntil` and the chain. The session key then signs each call (with a
/// per-key nonce) and anyone may submit it; Roles enforces what the role allows. The owner is an EVM
/// address: MetaMask itself, or the NEAR MPC address of a Freighter or Phantom wallet.
///
/// Refusals: "expired" (now > validUntil or validUntil more than 7 days ahead), "revoked",
/// "not owner" (grant not signed by the owner), "bad session sig".
contract SessionMember {
    address public immutable owner;
    IRoles public immutable roles;
    mapping(address => bool) public revoked;
    mapping(address => uint256) public nonces;

    bytes32 public constant TYPEHASH = keccak256("PrimeSession(address member,address sessionKey,uint64 validUntil,uint256 chainId)");
    bytes32 public constant DOMAIN = keccak256(abi.encode(keccak256("EIP712Domain(string name,string version)"), keccak256("Prime Session"), keccak256("1")));

    constructor(address owner_, IRoles roles_) {
        owner = owner_;
        roles = roles_;
    }

    function grantDigest(address key, uint64 validUntil) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN, keccak256(abi.encode(TYPEHASH, address(this), key, validUntil, block.chainid))));
    }

    function callDigest(address key, address to, uint256 value, bytes calldata data, uint8 operation, bytes32 roleKey)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(address(this), block.chainid, nonces[key], to, value, keccak256(data), operation, roleKey));
    }

    function exec(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        bytes32 roleKey,
        address key,
        uint64 validUntil,
        bytes calldata grant,
        bytes calldata sessionSig
    ) external {
        require(block.timestamp <= validUntil && validUntil <= block.timestamp + 7 days, "expired");
        require(!revoked[key], "revoked");
        require(recover(grantDigest(key, validUntil), grant) == owner, "not owner");
        require(recover(callDigest(key, to, value, data, operation, roleKey), sessionSig) == key, "bad session sig");
        nonces[key]++;
        roles.execTransactionWithRole(to, value, data, operation, roleKey, true);
    }

    /// Ends one session early: the owner's grant for `key` with validUntil 0. Anyone may submit it.
    function revoke(address key, bytes calldata grant) external {
        require(recover(grantDigest(key, 0), grant) == owner, "not owner");
        revoked[key] = true;
    }

    function recover(bytes32 h, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "sig length");
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "high s");
        address a = ecrecover(h, v, r, s);
        require(a != address(0), "bad sig");
        return a;
    }
}
