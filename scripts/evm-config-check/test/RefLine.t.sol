// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RefLineBase} from "../script/RefLine.s.sol";

// The reference line of docs/evm.md on a fork of Base Sepolia, every phase in one test: the setup, the
// agent's and the Prime owners' moves scheduled on the move timelock with the band's refusals, the
// moves run after the delay with the gate's refusals and the kill switch, then recovery, the full stop
// and the restore. The clock moves between phases. script/RefLine.s.sol runs the same phases on chain.
// Run with FORK_URL set to a Base Sepolia RPC.
contract RefLineTest is RefLineBase {
    bool forked;

    function setUp() public {
        string memory url = vm.envOr("FORK_URL", "");
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;
    }

    function line(address singleton, address factory) internal {
        custodyKeys = [uint256(0xC1), 0xC2, 0xC3];
        primeKeys = [uint256(0xB1), 0xB2, 0xB3];
        agentKey = 0xA1;
        agent = vm.addr(agentKey);
        deployer = vm.addr(0xD1);
        stranger = address(0x5757);
        trustee = address(0x7157EE);
        moveDelay = 1 hours;
        recoveryDelay = 2 days;

        setupLine(singleton, factory, 1);
        scheduleLine();
        vm.warp(block.timestamp + moveDelay + 1);
        moveLine();
        vm.warp(block.timestamp + recoveryDelay);
        recoverLine();
        emit log_count(passed);
    }

    function test_refLine_safe141() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        line(SAFE_141, FACTORY_141);
        require(passed > 100, "count");
    }

    function test_refLine_safe150() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        line(SAFE_150, FACTORY_150);
        require(passed > 100, "count");
    }

    event log_count(uint256);
}
