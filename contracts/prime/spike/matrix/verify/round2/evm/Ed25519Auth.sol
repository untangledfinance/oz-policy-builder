// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IEd25519Verifier {
    function verify(bytes32 k, bytes32 r, bytes32 s, bytes calldata m) external pure returns (bool);
}

interface IRolesEd {
    function execTransactionWithRole(address to, uint256 value, bytes calldata data, uint8 operation, bytes32 roleKey, bool shouldRevert)
        external
        returns (bool);
}

/// Checks a Stellar (Freighter SEP-53) or Solana (Phantom signMessage) wallet's signature over readable text,
/// on EVM, without NEAR. kind 1 = Stellar: ed25519 over sha256("Stellar Signed Message:\n" || text);
/// kind 2 = Solana: ed25519 over the text itself.
abstract contract Ed25519Wallet {
    uint8 public immutable kind;
    bytes32 public immutable pk;
    IEd25519Verifier public immutable verifier;

    constructor(uint8 kind_, bytes32 pk_, IEd25519Verifier verifier_) {
        require(kind_ == 1 || kind_ == 2, "kind");
        require(!weakKey(pk_), "weak key");
        kind = kind_;
        pk = pk_;
        verifier = verifier_;
    }

    uint256 constant P = 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed;
    /// y of the order-8 points: from the encoding c7176a70...7792ac037a (and p - y for the other pair).
    uint256 constant Y8 = 0x7a03ac9277fdc74ec6cc392cfa53202a0f67100d760b3cba4fd84d3d706a17c7;

    /// The verifier does not reject small-order public keys, for which forgeries exist (R = identity, S = 0
    /// verifies any message for the identity key). Refuse those keys, and non-canonical encodings (y >= p).
    function weakKey(bytes32 pk_) public pure returns (bool) {
        uint256 y;
        for (uint256 i = 0; i < 32; i++) y |= uint256(uint8(pk_[i])) << (8 * i); // little-endian
        y &= (1 << 255) - 1;
        return y >= P || y == 0 || y == 1 || y == P - 1 || y == Y8 || y == P - Y8;
    }

    function signedBy(bytes memory text, bytes memory sig) internal view returns (bool) {
        if (sig.length != 64) return false;
        bytes32 r;
        bytes32 s;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
        }
        bytes memory m = kind == 1 ? abi.encodePacked(sha256(abi.encodePacked("Stellar Signed Message:\n", text))) : text;
        return verifier.verify(pk, r, s, m);
    }

    function hex32(bytes32 b) internal pure returns (string memory) {
        bytes memory o = new bytes(66);
        o[0] = "0";
        o[1] = "x";
        bytes16 h = "0123456789abcdef";
        for (uint256 i = 0; i < 32; i++) {
            o[2 + 2 * i] = h[uint8(b[i]) >> 4];
            o[3 + 2 * i] = h[uint8(b[i]) & 15];
        }
        return string(o);
    }

    function hexAddr(address a) internal pure returns (string memory) {
        bytes memory full = bytes(hex32(bytes32(uint256(uint160(a)))));
        bytes memory o = new bytes(42);
        o[0] = "0";
        o[1] = "x";
        for (uint256 i = 0; i < 40; i++) o[2 + i] = full[26 + i];
        return string(o);
    }

    function dec(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 n;
        for (uint256 t = v; t > 0; t /= 10) n++;
        bytes memory o = new bytes(n);
        for (; v > 0; v /= 10) o[--n] = bytes1(uint8(48 + (v % 10)));
        return string(o);
    }
}

/// A Safe owner for a Freighter or Phantom key (ERC-1271). The wallet approves a Safe transaction by signing
/// "Prime approval\nsafe: <safe>\nsafe tx: <safeTxHash>".
contract Ed25519Owner is Ed25519Wallet {
    constructor(uint8 kind_, bytes32 pk_, IEd25519Verifier v) Ed25519Wallet(kind_, pk_, v) {}

    function approvalText(address safe, bytes32 safeTxHash) public pure returns (string memory) {
        return string.concat("Prime approval\nsafe: ", hexAddr(safe), "\nsafe tx: ", hex32(safeTxHash));
    }

    /// Safe 1.4.1 calls the legacy form with the SafeTx pre-image; msg.sender is the Safe.
    function isValidSignature(bytes calldata data, bytes calldata sig) external view returns (bytes4) {
        return signedBy(bytes(approvalText(msg.sender, keccak256(data))), sig) ? bytes4(0x20c13b0b) : bytes4(0xffffffff);
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        return signedBy(bytes(approvalText(msg.sender, hash)), sig) ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

/// SessionMember for a Freighter or Phantom owner: the grant is readable text the wallet signs once;
/// the session key (secp256k1) then signs each call. Same rules as SessionMember.
contract SessionMemberEd is Ed25519Wallet {
    IRolesEd public immutable roles;
    mapping(address => bool) public revoked;
    mapping(address => uint256) public nonces;

    constructor(uint8 kind_, bytes32 pk_, IEd25519Verifier v, IRolesEd roles_) Ed25519Wallet(kind_, pk_, v) {
        roles = roles_;
    }

    function grantText(address key, uint64 validUntil) public view returns (string memory) {
        return string.concat("Prime session\nmember: ", hexAddr(address(this)), "\nsession key: ", hexAddr(key), "\nvalid until: ", dec(validUntil), "\nchain: ", dec(block.chainid));
    }

    function callDigest(address key, address to, uint256 value, bytes calldata data, uint8 operation, bytes32 roleKey) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, nonces[key], to, value, keccak256(data), operation, roleKey));
    }

    function exec(address to, uint256 value, bytes calldata data, uint8 operation, bytes32 roleKey, address key, uint64 validUntil, bytes calldata grant, bytes calldata sessionSig) external {
        require(block.timestamp <= validUntil && validUntil <= block.timestamp + 7 days, "expired");
        require(!revoked[key], "revoked");
        require(signedBy(bytes(grantText(key, validUntil)), grant), "not owner");
        require(ecrecover65(callDigest(key, to, value, data, operation, roleKey), sessionSig) == key, "bad session sig");
        nonces[key]++;
        roles.execTransactionWithRole(to, value, data, operation, roleKey, true);
    }

    function revoke(address key, bytes calldata grant) external {
        require(signedBy(bytes(grantText(key, 0)), grant), "not owner");
        revoked[key] = true;
    }

    function ecrecover65(bytes32 h, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "sig length");
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        require(uint256(bytes32(sig[32:64])) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "high s");
        address a = ecrecover(h, v, bytes32(sig[0:32]), bytes32(sig[32:64]));
        require(a != address(0), "bad sig");
        return a;
    }
}
