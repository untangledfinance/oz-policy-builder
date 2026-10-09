// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.6.8;

import "./Ed25519.sol";

/// Exposes chengwenxi/Ed25519 (unaudited) as a contract, for 0.8 callers.
contract Ed25519Verifier {
    function verify(bytes32 k, bytes32 r, bytes32 s, bytes calldata m) external pure returns (bool) {
        return Ed25519.verify(k, r, s, m);
    }
}
