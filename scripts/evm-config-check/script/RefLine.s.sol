// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {
    ISafe,
    IProxyFactory,
    ICreateCall,
    IMultiSend,
    ConditionFlat,
    IRoles,
    IERC20,
    IPool
} from "../test/ConfigOnly.t.sol";

// The Prime reference line on EVM, as docs/evm.md describes it: custody's moves wait in a timelock.
//
// Every contract the line uses is an unmodified deployment of existing code: Safe proxies of the
// canonical Safe singletons, ERC-1167 proxies of the Zodiac Roles v2.1.1 mastercopy, and two
// OpenZeppelin TimelockController 5.6.0 instances compiled from the npm package (one for moves, one
// for recovery). The venue and the token are Aave's test market on Base Sepolia.
//
// RefLineBase holds the configuration and the four phases of the run. test/RefLine.t.sol runs them on
// a fork with the clock moved between phases. The RefLine script below runs one phase at a time
// against a chain (`forge script --fork-url`), broadcasts nothing, and writes the phase's
// transactions to a plan file that refline.ts sends and checks.

interface VmLine {
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function addr(uint256) external returns (address);
    function prank(address) external;
    function deal(address, uint256) external;
    function getNonce(address) external view returns (uint64);
    function setNonceUnsafe(address, uint64) external;
    function computeCreateAddress(address, uint256) external pure returns (address);
    function envString(string calldata) external view returns (string memory);
    function envOr(string calldata, uint256) external view returns (uint256);
    function readFile(string calldata) external view returns (string memory);
    function parseJsonString(string calldata, string calldata) external pure returns (string memory);
    function parseJsonAddress(string calldata, string calldata) external pure returns (address);
    function parseJsonUint(string calldata, string calldata) external pure returns (uint256);
    function parseUint(string calldata) external pure returns (uint256);
    function writeFile(string calldata, string calldata) external;
    function writeLine(string calldata, string calldata) external;
    function toString(bytes calldata) external pure returns (string memory);
    function toString(address) external pure returns (string memory);
    function toString(uint256) external pure returns (string memory);
    function envOr(string calldata, string calldata) external view returns (string memory);
    function createSelectFork(string calldata) external returns (uint256);
    function warp(uint256) external;
    function skip(bool) external;
}

interface IAllowance {
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IFaucet {
    function mint(address token, address to, uint256 amount) external returns (uint256);
}

abstract contract RefLineBase {
    VmLine constant vm = VmLine(address(uint160(uint256(keccak256("hevm cheat code")))));

    // Base Sepolia (84532)
    address constant SAFE_141 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762; // SafeL2 1.4.1
    address constant FACTORY_141 = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant SAFE_150 = 0xEdd160fEBBD92E350D4D398fb636302fccd67C7e; // SafeL2 1.5.0
    address constant FACTORY_150 = 0x14F2982D601c9458F93bd70B218933A6f8165e7b;
    address constant MULTISEND = 0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526; // 1.4.1
    address constant CREATE_CALL = 0x9b35Af71d77eaf8d7e40252370304687390A1A52; // 1.4.1
    address constant ROLES = 0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5; // Zodiac Roles v2.1.1 mastercopy
    address constant POOL = 0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27; // Aave v3 pool
    address constant USDC = 0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f; // Aave test USDC (6 decimals)
    address constant AUSDC = 0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC;
    address constant FAUCET = 0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc; // Aave's test-market faucet
    address constant SENTINEL = address(1);

    // ParameterType
    uint8 constant NONE = 0;
    uint8 constant STATIC = 1;
    uint8 constant DYNAMIC = 2;
    uint8 constant CALLDATA = 5;
    // Operator
    uint8 constant PASS = 0;
    uint8 constant AND = 1;
    uint8 constant MATCHES = 5;
    uint8 constant EQUAL_TO_AVATAR = 15;
    uint8 constant EQUAL_TO = 16;
    uint8 constant LESS_THAN = 18;
    uint8 constant BITMASK = 21;
    uint8 constant WITHIN_ALLOWANCE = 28;
    // Roles status codes inside ConditionViolation(uint8,bytes32)
    uint8 constant S_DELEGATECALL = 1;
    uint8 constant S_TARGET = 2;
    uint8 constant S_FUNCTION = 3;
    uint8 constant S_PARAM = 7;
    uint8 constant S_GREATER = 9;
    uint8 constant S_BITMASK = 15;
    uint8 constant S_ALLOWANCE = 17;

    bytes4 constant CONDITION_VIOLATION = bytes4(keccak256("ConditionViolation(uint8,bytes32)"));
    bytes4 constant NO_MEMBERSHIP = bytes4(keccak256("NoMembership()")); // a module of the Roles proxy, not in the role
    bytes4 constant NOT_AUTHORIZED = bytes4(keccak256("NotAuthorized(address)")); // not a module of the Roles proxy
    bytes4 constant OWNER_ONLY = bytes4(keccak256("OwnableUnauthorizedAccount(address)"));
    bytes4 constant OP_STATE = bytes4(keccak256("TimelockUnexpectedOperationState(bytes32,bytes32)"));
    bytes4 constant UNAUTHORIZED_CALLER = bytes4(keccak256("TimelockUnauthorizedCaller(address)"));
    bytes4 constant ACCESS_DENIED = bytes4(keccak256("AccessControlUnauthorizedAccount(address,bytes32)"));
    bytes4 constant ERROR_STRING = 0x08c379a0; // Error(string), Safe's GS codes

    bytes32 constant TRADE = "prime-trading"; // custody's role for the move timelock
    bytes32 constant RECOVER = "recovery"; // custody's role for the recovery timelock
    bytes32 constant BAND = "agent-low"; // the Prime account's role for the agent
    bytes32 constant CUSTODY_BUDGET = "custody-daily"; // custody's outflow cap, per day
    bytes32 constant AGENT_DAILY = "agent-daily"; // the agent's cap, per day

    // the line
    address custody; // the custody Safe (3 of 3): holds every asset
    address gate; // the custody gate: a Roles modifier on the custody Safe
    address prime; // the Prime account (2 of 3): holds nothing
    address primeRoles; // the Prime account's Roles modifier: the agent's band
    TimelockController moves; // the move timelock: the gate's trading member
    TimelockController recovery; // the recovery timelock: the gate's recovery member

    // the keys
    uint256[3] custodyKeys;
    uint256[3] primeKeys;
    uint256 agentKey;
    address deployer;
    address agent;
    address stranger;
    address trustee;
    uint256 moveDelay;
    uint256 recoveryDelay;

    // the run
    uint256 passed;
    bool recording; // the script records each transaction to a plan; the test does not
    string planPath;
    uint256 steps;
    string clock; // the timelock a recorded transaction schedules on: "move", "recovery" or ""

    // ------------------------------------------------------------------ helpers

    function owners(uint256[3] storage keys) internal returns (address[] memory list) {
        list = new address[](3);
        for (uint256 i; i < 3; i++) {
            list[i] = vm.addr(keys[i]);
        }
    }

    function all(uint256[3] storage keys) internal view returns (uint256[] memory k) {
        k = new uint256[](3);
        for (uint256 i; i < 3; i++) {
            k[i] = keys[i];
        }
    }

    function some(uint256[3] storage keys, uint256 n) internal view returns (uint256[] memory k) {
        k = new uint256[](n);
        for (uint256 i; i < n; i++) {
            k[i] = keys[i];
        }
    }

    function one(address a) internal pure returns (address[] memory l) {
        l = new address[](1);
        l[0] = a;
    }

    function one(bytes32 k) internal pure returns (bytes32[] memory l) {
        l = new bytes32[](1);
        l[0] = k;
    }

    function yes() internal pure returns (bool[] memory l) {
        l = new bool[](1);
        l[0] = true;
    }

    function no() internal pure returns (bool[] memory l) {
        l = new bool[](1);
    }

    function entry(uint8 op, address to, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(op, to, uint256(0), data.length, data);
    }

    function proxyCode() internal pure returns (bytes memory) {
        return
            abi.encodePacked(hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", ROLES, hex"5af43d82803e903d91602b57fd5bf3");
    }

    function predict(address deployer_, bytes32 salt) internal pure returns (address) {
        return
            address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer_, salt, keccak256(proxyCode())))))
            );
    }

    /// The first entries of a Safe's own configuration batch: deploy a Roles proxy through CreateCall
    /// (delegatecall, so the Safe is the deployer), set it up with the Safe as owner, avatar and target,
    /// and enable it as the Safe's module.
    function deployRoles(address safe, bytes32 salt) internal pure returns (address roles, bytes memory batch) {
        roles = predict(safe, salt);
        batch = abi.encodePacked(
            entry(1, CREATE_CALL, abi.encodeCall(ICreateCall.performCreate2, (0, proxyCode(), salt))),
            entry(0, roles, abi.encodeCall(IRoles.setUp, (abi.encode(safe, safe, safe)))),
            entry(0, safe, abi.encodeCall(ISafe.enableModule, (roles)))
        );
    }

    function c(uint8 parent, uint8 paramType, uint8 op, bytes memory comp)
        internal
        pure
        returns (ConditionFlat memory)
    {
        return ConditionFlat(parent, paramType, op, comp);
    }

    function selectorMask(bytes4 sel) internal pure returns (bytes memory) {
        return abi.encodePacked(uint16(0), bytes15(bytes4(0xffffffff)), bytes15(sel));
    }

    function status(bytes memory err) internal pure returns (uint8 s) {
        require(err.length == 68 && bytes4(err) == CONDITION_VIOLATION, "not a ConditionViolation");
        assembly {
            s := mload(add(err, 36))
        }
    }

    function check(bool ok, string memory what) internal {
        require(ok, what);
        passed++;
    }

    function proxyImpl(bytes memory code) internal pure returns (address a) {
        require(code.length == 45, "not a 1167 proxy");
        assembly {
            a := shr(96, mload(add(code, 42)))
        }
    }

    function reasonIs(bytes memory ret, string memory reason, string memory what) internal pure {
        require(ret.length >= 68 && bytes4(ret) == ERROR_STRING, what);
        bytes memory body = new bytes(ret.length - 4);
        for (uint256 i; i < body.length; i++) {
            body[i] = ret[i + 4];
        }
        require(keccak256(bytes(abi.decode(body, (string)))) == keccak256(bytes(reason)), what);
    }

    function errorIs(bytes memory ret, bytes4 want, string memory what) internal pure {
        require(ret.length >= 4 && bytes4(ret) == want, what);
    }

    // ------------------------------------------------------------------ transactions

    function who(string memory role) internal view returns (address) {
        bytes32 r = keccak256(bytes(role));
        if (r == keccak256("deployer")) return deployer;
        if (r == keccak256("agent")) return agent;
        if (r == keccak256("stranger")) return stranger;
        revert("unknown role");
    }

    /// Runs one transaction from `role`, requires the expected outcome and, in the script, records it.
    function step(string memory label, string memory role, address to, bytes memory data, bool expectOk)
        internal
        returns (bytes memory ret)
    {
        bool ok;
        vm.prank(who(role));
        (ok, ret) = to.call(data);
        require(ok == expectOk, label);
        write(label, role, to, 0, data, expectOk, ret, address(0));
        passed++;
    }

    /// A refused transaction whose revert is the gate's ConditionViolation with `want`.
    function refused(string memory label, string memory role, address to, bytes memory data, uint8 want) internal {
        bytes memory ret = step(label, role, to, data, false);
        require(status(ret) == want, label);
    }

    /// A refused transaction whose revert starts with the error `want`.
    function refusedWith(string memory label, string memory role, address to, bytes memory data, bytes4 want) internal {
        errorIs(step(label, role, to, data, false), want, label);
    }

    function write(
        string memory label,
        string memory role,
        address to,
        uint256 value,
        bytes memory data,
        bool expectOk,
        bytes memory ret,
        address created
    ) internal {
        if (!recording) {
            clock = "";
            return;
        }
        steps++;
        string memory line = string.concat(
            '{"n":',
            vm.toString(steps),
            ',"label":"',
            label,
            '","from":"',
            role,
            '","to":"',
            to == address(0) ? "" : vm.toString(to),
            '","value":"',
            vm.toString(value),
            '","data":"',
            vm.toString(data),
            '","expect":"',
            expectOk ? "ok" : "revert"
        );
        line = string.concat(line, '","revert":"', expectOk ? "" : vm.toString(ret), '","created":"');
        line = string.concat(line, created == address(0) ? "" : vm.toString(created), '","clock":"', clock, '"}');
        vm.writeLine(planPath, line);
        clock = "";
    }

    /// Signs a Safe transaction with the given owner keys (ascending owner order) and returns the
    /// execTransaction call any relayer can send.
    function safeCall(address safe, address to, bytes memory data, uint8 op, uint256[] memory keys)
        internal
        returns (bytes memory)
    {
        bytes32 h = ISafe(safe)
            .getTransactionHash(to, 0, data, op, 0, 0, 0, address(0), address(0), ISafe(safe).nonce());
        for (uint256 i; i < keys.length; i++) {
            for (uint256 j = i + 1; j < keys.length; j++) {
                if (vm.addr(keys[j]) < vm.addr(keys[i])) (keys[i], keys[j]) = (keys[j], keys[i]);
            }
        }
        bytes memory sigs;
        for (uint256 i; i < keys.length; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[i], h);
            sigs = abi.encodePacked(sigs, r, s, v);
        }
        return abi.encodeCall(ISafe.execTransaction, (to, 0, data, op, 0, 0, 0, address(0), address(0), sigs));
    }

    /// A Safe transaction the owners sign and the deployer relays; it must succeed.
    function safeOk(string memory label, address safe, address to, bytes memory data, uint8 op, uint256[] memory keys)
        internal
    {
        step(label, "deployer", safe, safeCall(safe, to, data, op, keys), true);
    }

    function gateCall(address to, bytes memory data, uint8 op, bytes32 role) internal pure returns (bytes memory) {
        return abi.encodeCall(IRoles.execTransactionWithRole, (to, 0, data, op, role, true));
    }

    function trade(address to, bytes memory data) internal pure returns (bytes memory) {
        return gateCall(to, data, 0, TRADE);
    }

    function supply(uint256 amount) internal view returns (bytes memory) {
        return abi.encodeCall(IPool.supply, (USDC, amount, custody, 0));
    }

    function recoverCall(address token, address to, uint256 amount) internal pure returns (bytes memory) {
        return gateCall(token, abi.encodeCall(IERC20.transfer, (to, amount)), 0, RECOVER);
    }

    function schedule(TimelockController tl, bytes memory call, bytes32 salt, uint256 delay)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodeCall(tl.schedule, (gate, 0, call, bytes32(0), salt, delay));
    }

    function execute(TimelockController tl, bytes memory call, bytes32 salt) internal view returns (bytes memory) {
        return abi.encodeCall(tl.execute, (gate, 0, call, bytes32(0), salt));
    }

    /// The agent's move: through its band, the Prime account schedules a gate call on the move timelock.
    function agentSchedules(bytes memory call, bytes32 salt) internal view returns (bytes memory) {
        return abi.encodeCall(
            IRoles.execTransactionWithRole, (address(moves), 0, schedule(moves, call, salt, moveDelay), 0, BAND, true)
        );
    }

    function agentSchedulesAt(address target, bytes memory call, bytes32 salt) internal view returns (bytes memory) {
        return abi.encodeCall(
            IRoles.execTransactionWithRole,
            (
                address(moves),
                0,
                abi.encodeCall(moves.schedule, (target, 0, call, bytes32(0), salt, moveDelay)),
                0,
                BAND,
                true
            )
        );
    }

    // ------------------------------------------------------------------ the configuration

    /// The custody gate: which venue calls the move timelock may make the custody Safe do, and what the
    /// recovery timelock may pay the trustee.
    function gateConfig() internal view returns (bytes memory) {
        // approve(spender, amount): spender is the pool, amount at most 1,000 per approval
        ConditionFlat[] memory approve = new ConditionFlat[](3);
        approve[0] = c(0, CALLDATA, MATCHES, "");
        approve[1] = c(0, STATIC, EQUAL_TO, abi.encode(POOL));
        approve[2] = c(0, STATIC, LESS_THAN, abi.encode(uint256(1_000e6 + 1)));
        // supply(asset, amount, onBehalfOf, referral): USDC, within custody's daily cap, on behalf of custody
        ConditionFlat[] memory supply_ = new ConditionFlat[](5);
        supply_[0] = c(0, CALLDATA, MATCHES, "");
        supply_[1] = c(0, STATIC, EQUAL_TO, abi.encode(USDC));
        supply_[2] = c(0, STATIC, WITHIN_ALLOWANCE, abi.encode(CUSTODY_BUDGET));
        supply_[3] = c(0, STATIC, EQUAL_TO_AVATAR, "");
        supply_[4] = c(0, STATIC, PASS, "");
        // withdraw(asset, amount, to): USDC, to custody
        ConditionFlat[] memory withdraw = new ConditionFlat[](4);
        withdraw[0] = c(0, CALLDATA, MATCHES, "");
        withdraw[1] = c(0, STATIC, EQUAL_TO, abi.encode(USDC));
        withdraw[2] = c(0, STATIC, PASS, "");
        withdraw[3] = c(0, STATIC, EQUAL_TO_AVATAR, "");
        // recovery: transfer(to, amount) of USDC or aUSDC, and withdraw, to the trustee only
        ConditionFlat[] memory toTrustee = new ConditionFlat[](3);
        toTrustee[0] = c(0, CALLDATA, MATCHES, "");
        toTrustee[1] = c(0, STATIC, EQUAL_TO, abi.encode(trustee));
        toTrustee[2] = c(0, STATIC, PASS, "");
        ConditionFlat[] memory withdrawToTrustee = new ConditionFlat[](4);
        withdrawToTrustee[0] = c(0, CALLDATA, MATCHES, "");
        withdrawToTrustee[1] = c(0, STATIC, PASS, "");
        withdrawToTrustee[2] = c(0, STATIC, PASS, "");
        withdrawToTrustee[3] = c(0, STATIC, EQUAL_TO, abi.encode(trustee));

        return abi.encodePacked(
            abi.encodePacked(
                entry(0, gate, abi.encodeCall(IRoles.scopeTarget, (TRADE, USDC))),
                entry(
                    0, gate, abi.encodeCall(IRoles.scopeFunction, (TRADE, USDC, IERC20.approve.selector, approve, 0))
                ),
                entry(0, gate, abi.encodeCall(IRoles.scopeTarget, (TRADE, POOL))),
                entry(0, gate, abi.encodeCall(IRoles.scopeFunction, (TRADE, POOL, IPool.supply.selector, supply_, 0))),
                entry(
                    0, gate, abi.encodeCall(IRoles.scopeFunction, (TRADE, POOL, IPool.withdraw.selector, withdraw, 0))
                ),
                entry(0, gate, abi.encodeCall(IRoles.setAllowance, (CUSTODY_BUDGET, 200e6, 200e6, 200e6, 1 days, 0))),
                entry(0, gate, abi.encodeCall(IRoles.assignRoles, (address(moves), one(TRADE), yes())))
            ),
            abi.encodePacked(
                entry(0, gate, abi.encodeCall(IRoles.scopeTarget, (RECOVER, USDC))),
                entry(
                    0,
                    gate,
                    abi.encodeCall(IRoles.scopeFunction, (RECOVER, USDC, IERC20.transfer.selector, toTrustee, 0))
                ),
                entry(0, gate, abi.encodeCall(IRoles.scopeTarget, (RECOVER, AUSDC))),
                entry(
                    0,
                    gate,
                    abi.encodeCall(IRoles.scopeFunction, (RECOVER, AUSDC, IERC20.transfer.selector, toTrustee, 0))
                ),
                entry(0, gate, abi.encodeCall(IRoles.scopeTarget, (RECOVER, POOL))),
                entry(
                    0,
                    gate,
                    abi.encodeCall(IRoles.scopeFunction, (RECOVER, POOL, IPool.withdraw.selector, withdrawToTrustee, 0))
                ),
                entry(0, gate, abi.encodeCall(IRoles.assignRoles, (address(recovery), one(RECOVER), yes())))
            )
        );
    }

    /// The agent's band on the Prime account: schedule, on the move timelock, one gate call that supplies
    /// USDC to the pool through the trading role, under 100 per move and within the agent's daily cap.
    function bandSchedule(address gate_) internal pure returns (ConditionFlat[] memory b) {
        b = new ConditionFlat[](23);
        b[0] = c(0, CALLDATA, MATCHES, ""); // schedule(target, value, data, predecessor, salt, delay)
        b[1] = c(0, STATIC, EQUAL_TO, abi.encode(gate_)); // target: the gate
        b[2] = c(0, STATIC, EQUAL_TO, abi.encode(uint256(0))); // value
        b[3] = c(0, NONE, AND, ""); // data
        b[4] = c(0, STATIC, PASS, ""); // predecessor
        b[5] = c(0, STATIC, PASS, ""); // salt
        b[6] = c(0, STATIC, PASS, ""); // delay: the timelock holds it to its minimum
        b[7] = c(3, CALLDATA, MATCHES, ""); // data is execTransactionWithRole(to, value, data, operation, role, shouldRevert)
        b[8] = c(3, DYNAMIC, BITMASK, selectorMask(IRoles.execTransactionWithRole.selector)); // and that selector
        b[9] = c(7, STATIC, EQUAL_TO, abi.encode(POOL)); // to
        b[10] = c(7, STATIC, EQUAL_TO, abi.encode(uint256(0))); // value
        b[11] = c(7, NONE, AND, ""); // data
        b[12] = c(7, STATIC, EQUAL_TO, abi.encode(uint256(0))); // operation: call
        b[13] = c(7, STATIC, EQUAL_TO, abi.encode(TRADE)); // role
        b[14] = c(7, STATIC, EQUAL_TO, abi.encode(true)); // shouldRevert
        b[15] = c(11, CALLDATA, MATCHES, ""); // data is supply(asset, amount, onBehalfOf, referral)
        b[16] = c(11, DYNAMIC, BITMASK, selectorMask(IPool.supply.selector)); // and supply's selector
        b[17] = c(15, STATIC, EQUAL_TO, abi.encode(USDC));
        b[18] = c(15, NONE, AND, "");
        b[19] = c(15, STATIC, PASS, ""); // onBehalfOf: the gate pins it to custody
        b[20] = c(15, STATIC, PASS, "");
        b[21] = c(18, STATIC, LESS_THAN, abi.encode(uint256(100e6))); // under 100 per move
        b[22] = c(18, STATIC, WITHIN_ALLOWANCE, abi.encode(AGENT_DAILY)); // within the agent's daily cap
    }

    // ------------------------------------------------------------------ phase 1: the line

    /// T1 to T3 of docs/evm.md: two Safes, the Prime account's band, the two timelocks, the gate.
    /// Then test USDC into custody and gas for the agent and the stranger.
    function setupLine(address singleton, address factory, uint256 salt) internal {
        uint64 n0 = vm.getNonce(deployer);

        // T1: the custody Safe (3 of 3) and the Prime account (2 of 3).
        bytes memory init = abi.encodeCall(
            ISafe.setup, (owners(custodyKeys), 3, address(0), "", address(0), address(0), 0, address(0))
        );
        custody = abi.decode(
            step(
                "T1a create the custody Safe (3 of 3)",
                "deployer",
                factory,
                abi.encodeCall(IProxyFactory.createProxyWithNonce, (singleton, init, salt)),
                true
            ),
            (address)
        );
        init =
            abi.encodeCall(ISafe.setup, (owners(primeKeys), 2, address(0), "", address(0), address(0), 0, address(0)));
        prime = abi.decode(
            step(
                "T1b create the Prime account (2 of 3)",
                "deployer",
                factory,
                abi.encodeCall(IProxyFactory.createProxyWithNonce, (singleton, init, salt + 1)),
                true
            ),
            (address)
        );

        // The two timelocks: OpenZeppelin TimelockController 5.6.0, the Prime account the only proposer,
        // anyone the executor, custody the admin until T3 renounces it.
        moves = timelock("move timelock (TimelockController 5.6.0)", moveDelay, n0 + 2);
        recovery = timelock("recovery timelock (TimelockController 5.6.0)", recoveryDelay, n0 + 3);

        // T2: the Prime account's Roles module and the agent's band, signed by 2 of 3 Prime owners.
        bytes memory batch;
        (primeRoles, batch) = deployRoles(prime, "prime-roles");
        address gateAddr = predict(custody, "custody-gate");
        batch = abi.encodePacked(
            batch,
            entry(0, primeRoles, abi.encodeCall(IRoles.scopeTarget, (BAND, address(moves)))),
            entry(
                0,
                primeRoles,
                abi.encodeCall(
                    IRoles.scopeFunction, (BAND, address(moves), moves.schedule.selector, bandSchedule(gateAddr), 0)
                )
            ),
            entry(0, primeRoles, abi.encodeCall(IRoles.setAllowance, (AGENT_DAILY, 50e6, 50e6, 50e6, 1 days, 0))),
            entry(0, primeRoles, abi.encodeCall(IRoles.assignRoles, (agent, one(BAND), yes())))
        );
        safeOk(
            "T2 the Prime account sets up its Roles module and the agent band (2 of 3)",
            prime,
            MULTISEND,
            abi.encodeCall(IMultiSend.multiSend, (batch)),
            1,
            some(primeKeys, 2)
        );

        // T3: the gate, its trading and recovery roles, custody's cap; custody takes the canceller role on
        // both timelocks and renounces their admin role. Signed by all three custody signers.
        (gate, batch) = deployRoles(custody, "custody-gate");
        batch = abi.encodePacked(batch, gateConfig(), timelockHandover(moves), timelockHandover(recovery));
        safeOk(
            "T3 custody sets up the gate, its trading and recovery roles and its cap (3 of 3)",
            custody,
            MULTISEND,
            abi.encodeCall(IMultiSend.multiSend, (batch)),
            1,
            all(custodyKeys)
        );
        check(gate == gateAddr, "gate address as predicted");

        step(
            "Aave faucet mints 1,000 test USDC to custody",
            "deployer",
            FAUCET,
            abi.encodeCall(IFaucet.mint, (USDC, custody, 1_000e6)),
            true
        );
        readBack();
    }

    function timelock(string memory label, uint256 delay, uint64 nonce) internal returns (TimelockController tl) {
        vm.setNonceUnsafe(deployer, nonce);
        vm.prank(deployer);
        tl = new TimelockController(delay, one(prime), one(address(0)), custody);
        require(address(tl) == vm.computeCreateAddress(deployer, nonce), "timelock address");
        write(
            label,
            "deployer",
            address(0),
            0,
            abi.encodePacked(
                type(TimelockController).creationCode, abi.encode(delay, one(prime), one(address(0)), custody)
            ),
            true,
            "",
            address(tl)
        );
        passed++;
    }

    function timelockHandover(TimelockController tl) internal view returns (bytes memory) {
        return abi.encodePacked(
            entry(0, address(tl), abi.encodeCall(tl.grantRole, (tl.CANCELLER_ROLE(), custody))),
            entry(0, address(tl), abi.encodeCall(tl.renounceRole, (tl.DEFAULT_ADMIN_ROLE(), custody)))
        );
    }

    /// The line read back.
    function readBack() internal {
        check(ISafe(custody).getThreshold() == 3, "custody is 3 of 3");
        check(ISafe(prime).getThreshold() == 2, "the Prime account is 2 of 3");
        check(
            IRoles(gate).owner() == custody && IRoles(gate).avatar() == custody && IRoles(gate).target() == custody,
            "gate wired to custody"
        );
        check(
            IRoles(primeRoles).owner() == prime && IRoles(primeRoles).avatar() == prime
                && IRoles(primeRoles).target() == prime,
            "band module wired to the Prime account"
        );
        check(ISafe(custody).isModuleEnabled(gate), "gate enabled on custody");
        check(ISafe(prime).isModuleEnabled(primeRoles), "band module enabled on the Prime account");
        check(gate.code.length == 45 && proxyImpl(gate.code) == ROLES, "gate is a proxy to Roles v2.1.1");
        check(
            primeRoles.code.length == 45 && proxyImpl(primeRoles.code) == ROLES,
            "band module is a proxy to Roles v2.1.1"
        );
        readBackTimelock(moves, moveDelay);
        readBackTimelock(recovery, recoveryDelay);
    }

    function readBackTimelock(TimelockController tl, uint256 delay) internal {
        check(!tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), custody), "custody renounced the timelock admin role");
        check(tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), address(tl)), "the timelock administers itself");
        check(tl.hasRole(tl.PROPOSER_ROLE(), prime), "the Prime account proposes");
        check(!tl.hasRole(tl.PROPOSER_ROLE(), custody), "custody cannot propose");
        check(!tl.hasRole(tl.PROPOSER_ROLE(), agent), "the agent cannot propose directly");
        check(tl.hasRole(tl.CANCELLER_ROLE(), prime), "the Prime account cancels");
        check(tl.hasRole(tl.CANCELLER_ROLE(), custody), "custody cancels");
        check(tl.hasRole(tl.EXECUTOR_ROLE(), address(0)), "anyone executes");
        check(tl.getMinDelay() == delay, "the delay");
    }

    // ------------------------------------------------------------------ phase 2: schedule, and refusals

    /// The agent schedules four moves, its band refuses the rest; the Prime owners schedule theirs, some
    /// of which the gate will refuse when they run; custody cancels one move; recoveries are scheduled.
    function scheduleLine() internal {
        // 1. The agent's moves: four supplies of 10, each scheduled through its band (40 of its 50 a day).
        clock = "move";
        step(
            "agent schedules move m1: supply 10",
            "agent",
            primeRoles,
            agentSchedules(trade(POOL, supply(10e6)), "m1"),
            true
        );
        clock = "move";
        step(
            "agent schedules move m2: supply 10 (custody cancels it)",
            "agent",
            primeRoles,
            agentSchedules(trade(POOL, supply(10e6)), "m2"),
            true
        );
        clock = "move";
        step(
            "agent schedules move m3: supply 10 (runs after the kill switch)",
            "agent",
            primeRoles,
            agentSchedules(trade(POOL, supply(10e6)), "m3"),
            true
        );
        clock = "move";
        step(
            "agent schedules move m4: supply 10 (runs after the restore)",
            "agent",
            primeRoles,
            agentSchedules(trade(POOL, supply(10e6)), "m4"),
            true
        );
        check(IERC20(USDC).balanceOf(custody) == 1_000e6, "nothing moves when a move is scheduled");

        // 2. The band's refusals, at schedule time, with the Roles status.
        refused(
            "refused: agent schedules a supply of 100, over its band",
            "agent",
            primeRoles,
            agentSchedules(trade(POOL, supply(100e6)), "x"),
            S_GREATER
        );
        refused(
            "refused: agent schedules a supply of 20 with 10 left of its daily 50",
            "agent",
            primeRoles,
            agentSchedules(trade(POOL, supply(20e6)), "x"),
            S_ALLOWANCE
        );
        refused(
            "refused: agent schedules a supply of another asset (aUSDC)",
            "agent",
            primeRoles,
            agentSchedules(trade(POOL, abi.encodeCall(IPool.supply, (AUSDC, 1e6, custody, 0))), "x"),
            S_PARAM
        );
        refused(
            "refused: agent schedules a withdraw, a call its band does not list",
            "agent",
            primeRoles,
            agentSchedules(trade(POOL, abi.encodeCall(IPool.withdraw, (USDC, 1e6, custody))), "x"),
            S_BITMASK
        );
        refused(
            "refused: agent schedules a USDC transfer, a call its band does not list",
            "agent",
            primeRoles,
            agentSchedules(trade(USDC, abi.encodeCall(IERC20.transfer, (stranger, 1e6))), "x"),
            S_PARAM
        );
        refused(
            "refused: agent schedules a supply at an off-list target",
            "agent",
            primeRoles,
            agentSchedules(trade(stranger, supply(1e6)), "x"),
            S_PARAM
        );
        refused(
            "refused: agent schedules a call to the custody Safe instead of the gate",
            "agent",
            primeRoles,
            agentSchedulesAt(custody, trade(POOL, supply(1e6)), "x"),
            S_PARAM
        );
        refused(
            "refused: agent schedules a supply under the recovery role",
            "agent",
            primeRoles,
            agentSchedules(gateCall(POOL, supply(1e6), 0, RECOVER), "x"),
            S_PARAM
        );
        refused(
            "refused: agent schedules a delegatecall from custody",
            "agent",
            primeRoles,
            agentSchedules(gateCall(POOL, supply(1e6), 1, TRADE), "x"),
            S_PARAM
        );
        refused(
            "refused: agent calls the move timelock's execute through its band",
            "agent",
            primeRoles,
            abi.encodeCall(
                IRoles.execTransactionWithRole,
                (address(moves), 0, execute(moves, trade(POOL, supply(10e6)), "m1"), 0, BAND, true)
            ),
            S_FUNCTION
        );
        refusedWith(
            "refused: agent schedules on the move timelock directly",
            "agent",
            address(moves),
            schedule(moves, trade(POOL, supply(1e6)), "x", moveDelay),
            ACCESS_DENIED
        );
        refusedWith("refused: agent calls the gate directly", "agent", gate, trade(POOL, supply(1e6)), NOT_AUTHORIZED);
        refusedWith(
            "refused: a stranger uses the agent band",
            "stranger",
            primeRoles,
            agentSchedules(trade(POOL, supply(1e6)), "x"),
            NOT_AUTHORIZED
        );
        refusedWith(
            "refused: agent runs m1 before the delay",
            "agent",
            address(moves),
            execute(moves, trade(POOL, supply(10e6)), "m1"),
            OP_STATE
        );

        // 3. The Prime owners schedule their own moves on the move timelock, in one Safe transaction
        //    (2 of 3): an approval, a supply, one over custody's cap, a withdrawal to custody, and calls
        //    the gate refuses when they run.
        clock = "move";
        safeOk(
            "Prime owners schedule 16 moves in one transaction (2 of 3)",
            prime,
            MULTISEND,
            abi.encodeCall(IMultiSend.multiSend, (ownerMoves())),
            1,
            some(primeKeys, 2)
        );

        // 4. Custody cancels the agent's m2 during the wait (3 of 3).
        safeOk(
            "custody cancels m2 during the wait (3 of 3)",
            custody,
            address(moves),
            abi.encodeCall(moves.cancel, (moveId(trade(POOL, supply(10e6)), "m2"))),
            0,
            all(custodyKeys)
        );

        // 5. Recovery: the Prime owners schedule four on the recovery timelock, a stranger cannot, custody
        //    cancels r1, and the delay cannot be cut.
        refusedWith(
            "refused: a stranger schedules a recovery",
            "stranger",
            address(recovery),
            schedule(recovery, recoverCall(AUSDC, trustee, 20e6), "r0", recoveryDelay),
            ACCESS_DENIED
        );
        bytes memory rs = abi.encodePacked(
            entry(0, address(recovery), schedule(recovery, recoverCall(AUSDC, trustee, 20e6), "r1", recoveryDelay)),
            entry(0, address(recovery), schedule(recovery, recoverCall(AUSDC, trustee, 20e6), "r2", recoveryDelay)),
            entry(0, address(recovery), schedule(recovery, recoverCall(USDC, stranger, 1e6), "r3", recoveryDelay)),
            entry(0, address(recovery), schedule(recovery, recoverCall(USDC, trustee, 1e6), "r4", recoveryDelay))
        );
        clock = "recovery";
        safeOk(
            "Prime owners schedule recoveries r1 to r4 in one transaction (2 of 3)",
            prime,
            MULTISEND,
            abi.encodeCall(IMultiSend.multiSend, (rs)),
            1,
            some(primeKeys, 2)
        );
        refusedWith(
            "refused: a stranger runs recovery r2 before the delay",
            "stranger",
            address(recovery),
            execute(recovery, recoverCall(AUSDC, trustee, 20e6), "r2"),
            OP_STATE
        );
        safeOk(
            "custody cancels recovery r1 (3 of 3)",
            custody,
            address(recovery),
            abi.encodeCall(
                recovery.cancel, (recovery.hashOperation(gate, 0, recoverCall(AUSDC, trustee, 20e6), bytes32(0), "r1"))
            ),
            0,
            all(custodyKeys)
        );
        refusedWith(
            "refused: a stranger sets the move delay to 0 directly",
            "stranger",
            address(moves),
            abi.encodeCall(moves.updateDelay, (0)),
            UNAUTHORIZED_CALLER
        );
        refusedWith(
            "refused: a stranger schedules a move delay of 0",
            "stranger",
            address(moves),
            abi.encodeCall(
                moves.schedule,
                (address(moves), 0, abi.encodeCall(moves.updateDelay, (0)), bytes32(0), bytes32("d"), moveDelay)
            ),
            ACCESS_DENIED
        );
        check(IERC20(USDC).balanceOf(custody) == 1_000e6, "still nothing has moved");
    }

    function moveId(bytes memory call, bytes32 salt) internal view returns (bytes32) {
        return moves.hashOperation(gate, 0, call, bytes32(0), salt);
    }

    function ownerMove(bytes memory call, bytes32 salt) internal view returns (bytes memory) {
        return entry(0, address(moves), schedule(moves, call, salt, moveDelay));
    }

    /// The Prime owners' moves, keyed by salt: o* run, x* are refused by the gate when they run.
    function ownerMoves() internal view returns (bytes memory) {
        return abi.encodePacked(
            abi.encodePacked(
                ownerMove(trade(USDC, abi.encodeCall(IERC20.approve, (POOL, 1_000e6))), "o-approve"),
                ownerMove(trade(POOL, supply(140e6)), "o1"),
                ownerMove(trade(POOL, supply(51e6)), "o2"),
                ownerMove(trade(POOL, abi.encodeCall(IPool.withdraw, (USDC, 5e6, custody))), "o3"),
                ownerMove(trade(POOL, abi.encodeCall(IPool.supply, (USDC, 10e6, stranger, 0))), "x1"),
                ownerMove(trade(POOL, abi.encodeCall(IPool.withdraw, (USDC, 1e6, stranger))), "x2"),
                ownerMove(trade(USDC, abi.encodeCall(IERC20.transfer, (stranger, 1e6))), "x3"),
                ownerMove(trade(USDC, abi.encodeCall(IERC20.approve, (stranger, 1e6))), "x4")
            ),
            abi.encodePacked(
                ownerMove(trade(AUSDC, abi.encodeCall(IERC20.transfer, (stranger, 1e6))), "x5"),
                ownerMove(trade(POOL, abi.encodeCall(IPool.borrow, (USDC, 1e6, 2, 0, custody))), "x6"),
                ownerMove(gateCall(POOL, supply(1e6), 1, TRADE), "x7"),
                ownerMove(trade(custody, abi.encodeCall(ISafe.addOwnerWithThreshold, (stranger, 1))), "x8"),
                ownerMove(trade(gate, abi.encodeCall(IRoles.assignRoles, (stranger, one(TRADE), yes()))), "x9"),
                ownerMove(recoverCall(USDC, trustee, 1e6), "x10"),
                ownerMove(abi.encodeCall(IRoles.assignRoles, (stranger, one(TRADE), yes())), "x11"),
                ownerMove(trade(POOL, abi.encodeCall(IPool.withdraw, (USDC, 1e6, custody))), "x12")
            )
        );
    }

    // ------------------------------------------------------------------ phase 3: the moves run

    /// After the move delay: anyone runs each move; the gate checks it then, against the trading role and
    /// custody's cap. Then the kill switch.
    function moveLine() internal {
        require(moves.isOperationReady(moveId(trade(POOL, supply(10e6)), "m1")), "the move delay has not passed");
        step(
            "a keeper runs o-approve: custody approves the pool for 1,000",
            "stranger",
            address(moves),
            execute(moves, trade(USDC, abi.encodeCall(IERC20.approve, (POOL, 1_000e6))), "o-approve"),
            true
        );
        check(IAllowance(USDC).allowance(custody, POOL) == 1_000e6, "custody approved the pool");

        uint256 usdc0 = IERC20(USDC).balanceOf(custody);
        uint256 a0 = IERC20(AUSDC).balanceOf(custody);
        step(
            "agent runs m1: custody supplies 10 to the pool",
            "agent",
            address(moves),
            execute(moves, trade(POOL, supply(10e6)), "m1"),
            true
        );
        check(IERC20(USDC).balanceOf(custody) == usdc0 - 10e6, "custody paid 10");
        check(IERC20(AUSDC).balanceOf(custody) + 2 >= a0 + 10e6, "custody holds the aUSDC");
        check(
            IERC20(USDC).balanceOf(prime) == 0 && IERC20(AUSDC).balanceOf(prime) == 0, "the Prime account holds nothing"
        );
        check(
            IERC20(USDC).balanceOf(address(moves)) == 0 && IERC20(AUSDC).balanceOf(address(moves)) == 0,
            "the move timelock holds nothing"
        );
        check(IERC20(USDC).balanceOf(agent) == 0 && IERC20(AUSDC).balanceOf(agent) == 0, "the agent holds nothing");

        refusedWith(
            "refused: agent runs the cancelled m2",
            "agent",
            address(moves),
            execute(moves, trade(POOL, supply(10e6)), "m2"),
            OP_STATE
        );
        step(
            "a keeper runs o1: custody supplies 140 (150 of its 200 a day used)",
            "stranger",
            address(moves),
            execute(moves, trade(POOL, supply(140e6)), "o1"),
            true
        );
        refused(
            "refused: o2 runs, a supply of 51 with 50 left of custody's daily 200",
            "stranger",
            address(moves),
            execute(moves, trade(POOL, supply(51e6)), "o2"),
            S_ALLOWANCE
        );
        uint256 u = IERC20(USDC).balanceOf(custody);
        step(
            "a keeper runs o3: custody withdraws 5 to itself",
            "stranger",
            address(moves),
            execute(moves, trade(POOL, abi.encodeCall(IPool.withdraw, (USDC, 5e6, custody))), "o3"),
            true
        );
        check(IERC20(USDC).balanceOf(custody) == u + 5e6, "custody got the 5 back");

        refused(
            "refused: x1 runs, a supply on behalf of a stranger",
            "stranger",
            address(moves),
            execute(moves, trade(POOL, abi.encodeCall(IPool.supply, (USDC, 10e6, stranger, 0))), "x1"),
            S_PARAM
        );
        refused(
            "refused: x2 runs, a withdrawal to a stranger",
            "stranger",
            address(moves),
            execute(moves, trade(POOL, abi.encodeCall(IPool.withdraw, (USDC, 1e6, stranger))), "x2"),
            S_PARAM
        );
        refused(
            "refused: x3 runs, a USDC transfer out of custody",
            "stranger",
            address(moves),
            execute(moves, trade(USDC, abi.encodeCall(IERC20.transfer, (stranger, 1e6))), "x3"),
            S_FUNCTION
        );
        refused(
            "refused: x4 runs, an approval to a stranger",
            "stranger",
            address(moves),
            execute(moves, trade(USDC, abi.encodeCall(IERC20.approve, (stranger, 1e6))), "x4"),
            S_PARAM
        );
        refused(
            "refused: x5 runs, an aUSDC transfer",
            "stranger",
            address(moves),
            execute(moves, trade(AUSDC, abi.encodeCall(IERC20.transfer, (stranger, 1e6))), "x5"),
            S_TARGET
        );
        refused(
            "refused: x6 runs, a borrow against custody's position",
            "stranger",
            address(moves),
            execute(moves, trade(POOL, abi.encodeCall(IPool.borrow, (USDC, 1e6, 2, 0, custody))), "x6"),
            S_FUNCTION
        );
        refused(
            "refused: x7 runs, a delegatecall from custody",
            "stranger",
            address(moves),
            execute(moves, gateCall(POOL, supply(1e6), 1, TRADE), "x7"),
            S_DELEGATECALL
        );
        refused(
            "refused: x8 runs, an owner added to custody",
            "stranger",
            address(moves),
            execute(moves, trade(custody, abi.encodeCall(ISafe.addOwnerWithThreshold, (stranger, 1))), "x8"),
            S_TARGET
        );
        refused(
            "refused: x9 runs, a gate rule changed through the gate",
            "stranger",
            address(moves),
            execute(moves, trade(gate, abi.encodeCall(IRoles.assignRoles, (stranger, one(TRADE), yes()))), "x9"),
            S_TARGET
        );
        refusedWith(
            "refused: x10 runs, the recovery role used by the move timelock",
            "stranger",
            address(moves),
            execute(moves, recoverCall(USDC, trustee, 1e6), "x10"),
            NO_MEMBERSHIP
        );
        refusedWith(
            "refused: x11 runs, a gate rule written by the move timelock",
            "stranger",
            address(moves),
            execute(moves, abi.encodeCall(IRoles.assignRoles, (stranger, one(TRADE), yes())), "x11"),
            OWNER_ONLY
        );

        // The kill switch: custody revokes the move timelock's trading role. Moves already scheduled fail.
        safeOk(
            "kill switch: custody revokes the trading role (3 of 3)",
            custody,
            gate,
            abi.encodeCall(IRoles.assignRoles, (address(moves), one(TRADE), no())),
            0,
            all(custodyKeys)
        );
        refusedWith(
            "refused after the kill switch: agent runs m3",
            "agent",
            address(moves),
            execute(moves, trade(POOL, supply(10e6)), "m3"),
            NO_MEMBERSHIP
        );
        refusedWith(
            "refused after the kill switch: x12 runs, a withdrawal to custody",
            "stranger",
            address(moves),
            execute(moves, trade(POOL, abi.encodeCall(IPool.withdraw, (USDC, 1e6, custody))), "x12"),
            NO_MEMBERSHIP
        );
    }

    // ------------------------------------------------------------------ phase 4: recovery, stop, restore

    function recoverLine() internal {
        bytes memory r2 = recoverCall(AUSDC, trustee, 20e6);
        require(
            recovery.isOperationReady(recovery.hashOperation(gate, 0, r2, bytes32(0), "r2")),
            "the recovery delay has not passed"
        );
        refusedWith(
            "refused: a stranger runs the cancelled recovery r1",
            "stranger",
            address(recovery),
            execute(recovery, r2, "r1"),
            OP_STATE
        );
        uint256 t0 = IERC20(AUSDC).balanceOf(trustee);
        step(
            "recovery r2 with trading off: a stranger runs it, custody pays the trustee 20 aUSDC",
            "stranger",
            address(recovery),
            execute(recovery, r2, "r2"),
            true
        );
        check(IERC20(AUSDC).balanceOf(trustee) + 2 >= t0 + 20e6, "the trustee received 20 aUSDC");
        refused(
            "refused: recovery r3 runs, the gate refuses to pay a stranger",
            "stranger",
            address(recovery),
            execute(recovery, recoverCall(USDC, stranger, 1e6), "r3"),
            S_PARAM
        );

        // The full stop: custody turns the gate off; recovery stops too.
        safeOk(
            "full stop: custody disables the gate (3 of 3)",
            custody,
            custody,
            abi.encodeCall(ISafe.disableModule, (SENTINEL, gate)),
            0,
            all(custodyKeys)
        );
        bytes memory ret = step(
            "refused: recovery r4 runs while the gate is off",
            "stranger",
            address(recovery),
            execute(recovery, recoverCall(USDC, trustee, 1e6), "r4"),
            false
        );
        reasonIs(ret, "GS104", "r4");

        // Thresholds: two of three custody signers, and one Prime owner, are refused.
        ret = step(
            "refused: two of three custody signers re-enable the gate",
            "deployer",
            custody,
            safeCall(custody, custody, abi.encodeCall(ISafe.enableModule, (gate)), 0, some(custodyKeys, 2)),
            false
        );
        reasonIs(ret, "GS020", "two of three");
        ret = step(
            "refused: one Prime owner schedules a move",
            "deployer",
            prime,
            safeCall(
                prime, address(moves), schedule(moves, trade(POOL, supply(1e6)), "y", moveDelay), 0, some(primeKeys, 1)
            ),
            false
        );
        reasonIs(ret, "GS020", "one owner");

        // Restore: custody re-enables the gate and gives the trading role back, in one transaction. The
        // agent's m4, scheduled before the kill switch, runs.
        bytes memory batch = abi.encodePacked(
            entry(0, custody, abi.encodeCall(ISafe.enableModule, (gate))),
            entry(0, gate, abi.encodeCall(IRoles.assignRoles, (address(moves), one(TRADE), yes())))
        );
        safeOk(
            "restore: custody re-enables the gate and the trading role (3 of 3)",
            custody,
            MULTISEND,
            abi.encodeCall(IMultiSend.multiSend, (batch)),
            1,
            all(custodyKeys)
        );
        uint256 usdc0 = IERC20(USDC).balanceOf(custody);
        step(
            "agent runs m4 after the restore: custody supplies 10",
            "agent",
            address(moves),
            execute(moves, trade(POOL, supply(10e6)), "m4"),
            true
        );
        check(IERC20(USDC).balanceOf(custody) == usdc0 - 10e6, "custody paid 10 after the restore");
        check(
            IERC20(USDC).balanceOf(prime) == 0 && IERC20(AUSDC).balanceOf(prime) == 0, "the Prime account holds nothing"
        );
        check(IERC20(USDC).balanceOf(agent) == 0 && IERC20(AUSDC).balanceOf(agent) == 0, "the agent holds nothing");
        readBack();
    }
}

/// One phase per call against the chain given by --fork-url; nothing is broadcast. KEYS_JSON holds the
/// throwaway keys, PLAN the plan file to write, STATE the line's addresses (written by setup, read by
/// the later phases), MOVE_DELAY and DELAY the two timelock delays in seconds.
contract RefLine is RefLineBase {
    string statePath;

    function load() internal {
        string memory keys = vm.envString("KEYS_JSON");
        custodyKeys = [key(keys, "custody1"), key(keys, "custody2"), key(keys, "custody3")];
        primeKeys = [key(keys, "prime1"), key(keys, "prime2"), key(keys, "prime3")];
        deployer = vm.addr(key(keys, "deployer"));
        agentKey = key(keys, "agent");
        agent = vm.addr(agentKey);
        stranger = vm.addr(key(keys, "stranger"));
        trustee = vm.addr(key(keys, "trustee"));
        moveDelay = vm.envOr("MOVE_DELAY", uint256(120));
        recoveryDelay = vm.envOr("DELAY", uint256(300));
        recording = true;
        planPath = vm.envString("PLAN");
        statePath = vm.envString("STATE");
        vm.writeFile(planPath, "");
    }

    function key(string memory keys, string memory role) internal pure returns (uint256) {
        return vm.parseUint(vm.parseJsonString(keys, string.concat(".", role, ".privateKey")));
    }

    function loadState() internal {
        string memory s = vm.readFile(statePath);
        custody = vm.parseJsonAddress(s, ".custody");
        prime = vm.parseJsonAddress(s, ".prime");
        gate = vm.parseJsonAddress(s, ".gate");
        primeRoles = vm.parseJsonAddress(s, ".primeRoles");
        moves = TimelockController(payable(vm.parseJsonAddress(s, ".moveTimelock")));
        recovery = TimelockController(payable(vm.parseJsonAddress(s, ".recoveryTimelock")));
        require(vm.parseJsonUint(s, ".moveDelay") == moveDelay, "MOVE_DELAY differs from the line's");
        require(vm.parseJsonUint(s, ".recoveryDelay") == recoveryDelay, "DELAY differs from the line's");
    }

    function writeState() internal {
        string memory s = string.concat(
            '{"custody":"',
            vm.toString(custody),
            '","prime":"',
            vm.toString(prime),
            '","gate":"',
            vm.toString(gate),
            '","primeRoles":"',
            vm.toString(primeRoles),
            '","moveTimelock":"',
            vm.toString(address(moves)),
            '","recoveryTimelock":"',
            vm.toString(address(recovery))
        );
        s = string.concat(
            s,
            '","trustee":"',
            vm.toString(trustee),
            '","agent":"',
            vm.toString(agent),
            '","moveDelay":',
            vm.toString(moveDelay),
            ',"recoveryDelay":',
            vm.toString(recoveryDelay),
            "}"
        );
        vm.writeFile(statePath, s);
    }

    function done() internal {
        vm.writeLine(planPath, string.concat('{"checks":', vm.toString(passed), "}"));
    }

    function fund(string memory label, address to, uint256 value) internal {
        vm.deal(to, to.balance + value);
        write(label, "deployer", to, value, "", true, "", address(0));
    }

    function setupPhase() public {
        load();
        setupLine(SAFE_141, FACTORY_141, vm.envOr("SALT", block.timestamp));
        fund("gas for the agent", agent, vm.envOr("AGENT_GAS", uint256(150_000_000_000_000)));
        fund("gas for the stranger", stranger, vm.envOr("STRANGER_GAS", uint256(150_000_000_000_000)));
        writeState();
        done();
    }

    function schedulePhase() public {
        load();
        loadState();
        scheduleLine();
        done();
    }

    function movePhase() public {
        load();
        loadState();
        moveLine();
        done();
    }

    function recoverPhase() public {
        load();
        loadState();
        recoverLine();
        done();
    }
}
