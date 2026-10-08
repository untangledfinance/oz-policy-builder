// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Test venue for the contract-call spike (anvil fork only). It moves no token: it keeps a ledger, so a call is
/// proven by its effect on state and by msg.sender, not by a transfer.
contract Venue {
    mapping(address => uint256) public deposits;
    address public lastCaller;
    uint256 public calls;

    event Deposit(address indexed caller, address indexed onBehalfOf, uint256 amount);
    event Withdraw(address indexed caller, address indexed to, uint256 amount);

    function deposit(uint256 amount, address onBehalfOf) external {
        deposits[onBehalfOf] += amount;
        (lastCaller, calls) = (msg.sender, calls + 1);
        emit Deposit(msg.sender, onBehalfOf, amount);
    }

    function withdraw(uint256 amount, address to) external {
        deposits[to] -= amount;
        (lastCaller, calls) = (msg.sender, calls + 1);
        emit Withdraw(msg.sender, to, amount);
    }
}
