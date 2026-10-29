// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RefLineBase} from "../script/RefLine.s.sol";
import {IRoles, IERC20, IPool, ISafe, IMultiSend} from "./ConfigOnly.t.sol";

// STRIDE proof-of-concept cases for the move-timelock path of docs/evm.md (design B), on a fork of Base
// Sepolia. These extend the reference line with the attacks the direct-shape STRIDE (ConfigOnly.t.sol)
// never saw, because the move timelock did not exist there: the open executor, the agent's cap spent at
// scheduling, a scheduled move that outlives its band, the proposer's reach into the timelock's own
// delay, and salt replay. Each one is built from existing code only (Safe proxies, Zodiac Roles v2.1.1
// proxies, OpenZeppelin TimelockController 5.6.0) and refuses or demonstrates the behaviour with the
// exact Safe, Roles or TimelockController status. Run with FORK_URL set to a Base Sepolia RPC.
//
// Threat IDs match evidence/stride-evm.md section 11 (the move-timelock delta):
//   TL-D1  the open executor forces a ready move through before a cancel lands; readiness has no expiry
//   TL-D2  the agent's daily cap is spent at scheduling and a cancel does not refund it
//   TL-E1  revoking the agent's band leaves its already-scheduled moves executable
//   TL-E2  the Prime account (2 of 3), the sole proposer, can schedule the timelock's own updateDelay
//   TL-T1  a move's salt is open: the same salt cannot be re-scheduled, a new salt can
contract StrideTimelockTest is RefLineBase {
    bool forked;

    // Zodiac Roles wraps a failing module transaction (shouldRevert = true) in this error.
    bytes4 constant MODULE_TX_FAILED = bytes4(keccak256("ModuleTransactionFailed()"));

    function setUp() public {
        string memory url = vm.envOr("FORK_URL", "");
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;
    }

    function base(address singleton, address factory) internal {
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
    }

    // ---- helpers specific to the delta -------------------------------------------------------------

    /// The Prime account's owners (2 of 3) schedule a gate call directly on the move timelock, without
    /// going through the agent's band. The band only constrains the agent; the owners are the proposer.
    function primeSchedules(bytes memory call, bytes32 salt) internal {
        safeOk(
            "prime owners schedule a move (2 of 3)",
            prime,
            address(moves),
            schedule(moves, call, salt, moveDelay),
            0,
            some(primeKeys, 2)
        );
    }

    /// The agent schedules a supply of `amount` through its band.
    function agentSupply(uint256 amount, bytes32 salt, bool ok) internal returns (bytes memory) {
        return step(
            "agent schedules a supply through its band",
            "agent",
            primeRoles,
            agentSchedules(trade(POOL, supply(amount)), salt),
            ok
        );
    }

    function stranger_runs(bytes memory call, bytes32 salt, bool ok) internal returns (bytes memory) {
        return step("a stranger executes a ready move", "stranger", address(moves), execute(moves, call, salt), ok);
    }

    function fresh_day() internal {
        // past a full allowance period so the agent's and custody's daily caps refill
        vm.warp(block.timestamp + 1 days + 1);
    }

    // ---- the run ------------------------------------------------------------------------------------

    function runStride() internal {
        // Custody approves the pool so the supplies below can actually move funds: the Prime owners
        // schedule it, the clock passes, a stranger runs it.
        primeSchedules(trade(USDC, abi.encodeCall(IERC20.approve, (POOL, 1_000e6))), "ap");
        vm.warp(block.timestamp + moveDelay + 1);
        stranger_runs(trade(USDC, abi.encodeCall(IERC20.approve, (POOL, 1_000e6))), "ap", true);

        strideD1_openExecutor();
        fresh_day();
        strideD2_capNotRefunded();
        fresh_day();
        strideT1_saltReplay();
        fresh_day();
        strideE1_bandRevokeLeavesMoves();
        strideE2_proposerReachesDelay();

        emit log_count(passed);
    }

    /// TL-D1: the open executor. Once a move is ready, a stranger runs it before a cancel can land, and a
    /// ready move never expires, so it sits runnable until it is cancelled or the kill switch drops it.
    function strideD1_openExecutor() internal {
        // (a) forced execution: custody means to cancel, a keeper runs it first; custody's cancel then
        //     reverts because the operation is already done.
        agentSupply(10e6, "f1", true);
        vm.warp(block.timestamp + moveDelay + 1);
        uint256 before = IERC20(USDC).balanceOf(custody);
        stranger_runs(trade(POOL, supply(10e6)), "f1", true);
        check(IERC20(USDC).balanceOf(custody) == before - 10e6, "the forced move moved custody's funds");
        check(moves.isOperationDone(moveId(trade(POOL, supply(10e6)), "f1")), "f1 is done, the window has closed");
        // custody's cancel now reverts: the operation is no longer pending (the Safe surfaces the inner
        // TimelockUnexpectedOperationState as its own call-failed code).
        step(
            "custody cancels f1 after it already ran",
            "deployer",
            custody,
            safeCall(
                custody,
                address(moves),
                abi.encodeCall(moves.cancel, (moveId(trade(POOL, supply(10e6)), "f1"))),
                0,
                all(custodyKeys)
            ),
            false
        );

        // (b) readiness has no upper window: schedule, let a month pass, a stranger still runs it.
        agentSupply(10e6, "f2", true);
        vm.warp(block.timestamp + 30 days);
        before = IERC20(USDC).balanceOf(custody);
        stranger_runs(trade(POOL, supply(10e6)), "f2", true);
        check(IERC20(USDC).balanceOf(custody) == before - 10e6, "a month-old ready move still runs");
    }

    /// TL-D2: the agent's daily cap is consumed when a move is scheduled, and a cancel does not refund it.
    function strideD2_capNotRefunded() internal {
        // Five supplies of 10 spend the agent's whole 50-a-day at scheduling.
        agentSupply(10e6, "s1", true);
        agentSupply(10e6, "s2", true);
        agentSupply(10e6, "s3", true);
        agentSupply(10e6, "s4", true);
        agentSupply(10e6, "s5", true);
        // Custody cancels one during the wait.
        safeOk(
            "custody cancels s3 during the wait (3 of 3)",
            custody,
            address(moves),
            abi.encodeCall(moves.cancel, (moveId(trade(POOL, supply(10e6)), "s3"))),
            0,
            all(custodyKeys)
        );
        // The cancelled move still counts: a sixth supply is over the cap for the day.
        bytes memory ret = agentSupply(10e6, "s6", false);
        require(status(ret) == S_ALLOWANCE, "a cancel does not refund the agent's cap");
        passed++;
    }

    /// TL-T1: a move's salt is left open in the band. The same operation id cannot be scheduled twice, but
    /// a new salt makes a fresh operation (each one spends the agent's cap).
    function strideT1_saltReplay() internal {
        agentSupply(10e6, "rp", true);
        // Same salt, same call: the timelock refuses a duplicate operation id. Roles wraps the inner
        // TimelockUnexpectedOperationState in ModuleTransactionFailed because the band pins shouldRevert.
        bytes memory ret = agentSupply(10e6, "rp", false);
        errorIs(ret, MODULE_TX_FAILED, "same-salt schedule refused as a duplicate operation");
        passed++;
        // A different salt is a new, valid operation.
        agentSupply(10e6, "rp2", true);
    }

    /// TL-E1: revoking the agent's band stops new schedules, but a move it already scheduled still runs.
    function strideE1_bandRevokeLeavesMoves() internal {
        agentSupply(10e6, "br", true);
        // The Prime owners revoke the agent's band, believing they have stopped it.
        safeOk(
            "prime owners revoke the agent's band (2 of 3)",
            prime,
            primeRoles,
            abi.encodeCall(IRoles.assignRoles, (agent, one(BAND), no())),
            0,
            some(primeKeys, 2)
        );
        // New schedules are refused: the agent is no longer a member of the band.
        refusedWith(
            "refused: the agent schedules after its band is revoked",
            "agent",
            primeRoles,
            agentSchedules(trade(POOL, supply(10e6)), "br2"),
            NO_MEMBERSHIP
        );
        // The move scheduled before the revoke is still live: it runs after the delay.
        vm.warp(block.timestamp + moveDelay + 1);
        uint256 before = IERC20(USDC).balanceOf(custody);
        stranger_runs(trade(POOL, supply(10e6)), "br", true);
        check(
            IERC20(USDC).balanceOf(custody) == before - 10e6, "a move scheduled before the band was revoked still runs"
        );
    }

    /// TL-E2: the Prime account, the sole proposer, can schedule the timelock's own updateDelay. Custody's
    /// canceller is the backstop; if it does not cancel, the cancel window collapses, but custody's gate
    /// kill switch is independent of the timelock's delay and still stops every move.
    function strideE2_proposerReachesDelay() internal {
        bytes memory setZero = abi.encodeCall(moves.updateDelay, (0));
        // the schedule call targets the timelock itself (a self-administered op), not the gate
        bytes memory scheduleD0 =
            abi.encodeCall(moves.schedule, (address(moves), 0, setZero, bytes32(0), bytes32("d0"), moveDelay));
        bytes memory scheduleD1 =
            abi.encodeCall(moves.schedule, (address(moves), 0, setZero, bytes32(0), bytes32("d1"), moveDelay));
        // (a) the Prime owners (2 of 3) schedule updateDelay(0) on the timelock itself.
        safeOk(
            "prime owners schedule the timelock's updateDelay(0) (2 of 3)",
            prime,
            address(moves),
            scheduleD0,
            0,
            some(primeKeys, 2)
        );
        // the call targets the timelock, not the gate, so this is a self-administered op
        bytes32 d0 = moves.hashOperation(address(moves), 0, setZero, bytes32(0), "d0");
        check(moves.isOperationPending(d0), "updateDelay(0) is pending, proposed by the Prime account");
        // (b) custody's canceller is the backstop: it cancels the pending delay change.
        safeOk(
            "custody cancels the proposed updateDelay (3 of 3)",
            custody,
            address(moves),
            abi.encodeCall(moves.cancel, (d0)),
            0,
            all(custodyKeys)
        );
        check(!moves.isOperation(d0), "custody cancelled the delay change");

        // (c) the residual: if custody does not cancel, the change runs after the current delay and the
        //     window collapses to zero. Schedule it again and let it through.
        safeOk(
            "prime owners schedule updateDelay(0) again (2 of 3)",
            prime,
            address(moves),
            scheduleD1,
            0,
            some(primeKeys, 2)
        );
        vm.warp(block.timestamp + moveDelay + 1);
        step(
            "a stranger runs the delay change",
            "stranger",
            address(moves),
            abi.encodeCall(moves.execute, (address(moves), 0, setZero, bytes32(0), bytes32("d1"))),
            true
        );
        check(moves.getMinDelay() == 0, "the move delay is now zero: no cancel window for future moves");

        // (d) even with no delay, custody's gate kill switch stops a move: it is a call on the gate, not
        //     on the timelock, so it does not depend on the timelock's delay. Custody revokes the trading
        //     role; a Prime-owner move then fails when it runs.
        primeSchedules(trade(POOL, supply(10e6)), "k1");
        safeOk(
            "kill switch: custody revokes the timelock's trading role (3 of 3)",
            custody,
            gate,
            abi.encodeCall(IRoles.assignRoles, (address(moves), one(TRADE), no())),
            0,
            all(custodyKeys)
        );
        vm.warp(block.timestamp + moveDelay + 1);
        refusedWith(
            "refused: a move runs after the kill switch, delay zero or not",
            "stranger",
            address(moves),
            execute(moves, trade(POOL, supply(10e6)), "k1"),
            NO_MEMBERSHIP
        );
    }

    function test_strideTimelock_safe141() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        base(SAFE_141, FACTORY_141);
        runStride();
        require(passed > 40, "count");
    }

    function test_strideTimelock_safe150() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        base(SAFE_150, FACTORY_150);
        runStride();
        require(passed > 40, "count");
    }

    event log_count(uint256);
}
