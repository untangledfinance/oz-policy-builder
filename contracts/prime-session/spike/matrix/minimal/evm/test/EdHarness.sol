// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {Ed25519} from "../lib/Ed25519.sol";
/// Test-only: exposes the ported library for the RFC 8032 / refusal vectors.
contract EdHarness {
    function verify(bytes32 k, bytes32 r, bytes32 s, bytes calldata m) external pure returns (bool) { return Ed25519.verify(k, r, s, m); }
}
