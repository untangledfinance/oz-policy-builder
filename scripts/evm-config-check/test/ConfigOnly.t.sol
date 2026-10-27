// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

// Prime on EVM, configuration only. Every contract this test deploys is an
// unmodified deployment of existing code: Safe proxies of the canonical Safe
// singletons, ERC-1167 proxies of the canonical Zodiac Roles v2.1.1
// mastercopy, and OpenZeppelin's TimelockController 5.6.0 compiled from the
// npm package. Venues and tokens are the live Base Sepolia ones. Run with
// FORK_URL set to a Base Sepolia RPC.

interface Vm {
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function addr(uint256) external returns (address);
    function createSelectFork(string calldata) external returns (uint256);
    function envOr(string calldata, string calldata) external returns (string memory);
    function prank(address) external;
    function warp(uint256) external;
    function skip(bool) external;
    function snapshotState() external returns (uint256);
    function revertToState(uint256) external returns (bool);
}

interface ISafe {
    function setup(address[] calldata, uint256, address, bytes calldata, address, address, uint256, address) external;
    function nonce() external view returns (uint256);
    function getTransactionHash(
        address,
        uint256,
        bytes calldata,
        uint8,
        uint256,
        uint256,
        uint256,
        address,
        address,
        uint256
    ) external view returns (bytes32);
    function execTransaction(
        address,
        uint256,
        bytes calldata,
        uint8,
        uint256,
        uint256,
        uint256,
        address,
        address,
        bytes memory
    ) external payable returns (bool);
    function enableModule(address) external;
    function disableModule(address, address) external;
    function isModuleEnabled(address) external view returns (bool);
    function addOwnerWithThreshold(address, uint256) external;
    function getThreshold() external view returns (uint256);
    function VERSION() external view returns (string memory);
}

interface IProxyFactory {
    function createProxyWithNonce(address, bytes memory, uint256) external returns (address);
}

interface ICreateCall {
    function performCreate2(uint256, bytes memory, bytes32) external returns (address);
}

interface IMultiSend {
    function multiSend(bytes memory) external payable;
}

struct ConditionFlat {
    uint8 parent;
    uint8 paramType;
    uint8 operator;
    bytes compValue;
}

interface IRoles {
    function setUp(bytes memory) external;
    function owner() external view returns (address);
    function avatar() external view returns (address);
    function target() external view returns (address);
    function assignRoles(address, bytes32[] calldata, bool[] calldata) external;
    function scopeTarget(bytes32, address) external;
    function revokeFunction(bytes32, address, bytes4) external;
    function scopeFunction(bytes32, address, bytes4, ConditionFlat[] memory, uint8) external;
    function setAllowance(bytes32, uint128, uint128, uint128, uint64, uint64) external;
    function setTransactionUnwrapper(address, bytes4, address) external;
    function execTransactionWithRole(address, uint256, bytes calldata, uint8, bytes32, bool) external returns (bool);
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function mint(address, uint256) external returns (bool);
}

interface IPool {
    function supply(address, uint256, address, uint16) external;
    function withdraw(address, uint256, address) external returns (uint256);
    function borrow(address, uint256, uint256, uint16, address) external;
}

contract ConfigOnlyTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    // Base Sepolia (84532)
    address constant SAFE_141 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762; // SafeL2 1.4.1
    address constant FACTORY_141 = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant SAFE_150 = 0xEdd160fEBBD92E350D4D398fb636302fccd67C7e; // SafeL2 1.5.0
    address constant FACTORY_150 = 0x14F2982D601c9458F93bd70B218933A6f8165e7b;
    address constant MULTISEND = 0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526; // 1.4.1
    address constant MULTISEND_CALL_ONLY = 0x9641d764fc13c8B624c04430C7356C1C7C8102e2; // 1.4.1
    address constant CREATE_CALL = 0x9b35Af71d77eaf8d7e40252370304687390A1A52; // 1.4.1
    address constant ROLES = 0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5; // Zodiac Roles v2.1.1 mastercopy
    address constant UNWRAPPER = 0x93B7fCbc63ED8a3a24B59e1C3e6649D50B7427c0; // Roles MultiSend unwrapper
    address constant POOL = 0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27; // Aave v3 pool
    address constant USDC = 0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f; // Aave test USDC (6 decimals)
    address constant AUSDC = 0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC;
    address constant USDC_MINTER = 0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc; // Aave faucet, the token's owner

    // ParameterType
    uint8 constant NONE = 0;
    uint8 constant STATIC = 1;
    uint8 constant DYNAMIC = 2;
    uint8 constant CALLDATA = 5;
    // Operator
    uint8 constant PASS = 0;
    uint8 constant AND = 1;
    uint8 constant OR = 2;
    uint8 constant MATCHES = 5;
    uint8 constant EQUAL_TO_AVATAR = 15;
    uint8 constant EQUAL_TO = 16;
    uint8 constant LESS_THAN = 18;
    uint8 constant BITMASK = 21;
    uint8 constant WITHIN_ALLOWANCE = 28;
    // Roles Status codes inside ConditionViolation(uint8,bytes32)
    uint8 constant S_DELEGATECALL = 1;
    uint8 constant S_TARGET = 2;
    uint8 constant S_FUNCTION = 3;
    uint8 constant S_SEND = 4;
    uint8 constant S_OR = 5;
    uint8 constant S_PARAM = 7;
    uint8 constant S_GREATER = 9;
    uint8 constant S_BITMASK = 15;
    uint8 constant S_ALLOWANCE = 17;

    bytes4 constant RETURN_DATA =
        bytes4(keccak256("execTransactionWithRoleReturnData(address,uint256,bytes,uint8,bytes32,bool)"));

    bytes32 constant TRADE = "prime-trading"; // custody's role for the Prime account
    bytes32 constant RECOVER = "recovery"; // custody's role for the recovery timelock
    bytes32 constant BAND = "agent-low"; // the Prime account's role for the agent
    bytes32 constant CUSTODY_BUDGET = "custody-daily"; // custody's outflow cap, per day
    bytes32 constant AGENT_DAILY = "agent-daily"; // the agent's cap, per day

    uint256[3] custodyKeys = [uint256(0xC1), 0xC2, 0xC3];
    uint256[3] primeKeys = [uint256(0xB1), 0xB2, 0xB3];
    uint256 constant AGENT_KEY = 0xA1;
    address agent;
    address trustee = address(0x7157EE);
    address stranger = address(0x5757);

    address custody; // the custody Safe: holds every asset
    address gate; // the custody gate: a Roles modifier on the custody Safe
    address prime; // the Prime account: a Safe, holds nothing
    address primeRoles; // the Prime account's Roles modifier: the agent's bands
    TimelockController timelock;

    uint256 passed;
    bool forked;

    function setUp() public {
        string memory url = vm.envOr("FORK_URL", "");
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;
        agent = vm.addr(AGENT_KEY);
    }

    // ---------------------------------------------------------------- helpers

    function owners(uint256[3] storage keys) internal returns (address[] memory list) {
        list = new address[](3);
        for (uint256 i; i < 3; i++) {
            list[i] = vm.addr(keys[i]);
        }
    }

    function createSafe(address singleton, address factory, address[] memory list, uint256 threshold, uint256 salt)
        internal
        returns (address)
    {
        bytes memory init =
            abi.encodeCall(ISafe.setup, (list, threshold, address(0), "", address(0), address(0), 0, address(0)));
        return IProxyFactory(factory).createProxyWithNonce(singleton, init, salt);
    }

    /// Signs a Safe transaction with the given owner keys (ascending owner order) and executes it.
    function execSafe(address safe, address to, bytes memory data, uint8 op, uint256[] memory keys)
        internal
        returns (bool)
    {
        bytes32 h = ISafe(safe)
            .getTransactionHash(to, 0, data, op, 0, 0, 0, address(0), address(0), ISafe(safe).nonce());
        // sort keys by address
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
        return ISafe(safe).execTransaction(to, 0, data, op, 0, 0, 0, address(0), address(0), sigs);
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

    function entry(uint8 op, address to, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(op, to, uint256(0), data.length, data);
    }

    function proxyCode() internal pure returns (bytes memory) {
        return
            abi.encodePacked(hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", ROLES, hex"5af43d82803e903d91602b57fd5bf3");
    }

    function predict(address deployer, bytes32 salt) internal pure returns (address) {
        return
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, keccak256(proxyCode()))))));
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
        // ConditionViolation(uint8,bytes32)
        require(err.length == 68, "not a ConditionViolation");
        require(bytes4(err) == bytes4(keccak256("ConditionViolation(uint8,bytes32)")), "other error");
        assembly {
            s := mload(add(err, 36))
        }
    }

    function check(bool ok, string memory what) internal {
        require(ok, what);
        passed++;
    }

    function refusedWith(bool ok, bytes memory err, uint8 want, string memory what) internal {
        require(!ok, what);
        require(status(err) == want, what);
        passed++;
    }

    function refusedWithError(bool ok, bytes memory err, bytes4 want, string memory what) internal {
        require(!ok, what);
        require(err.length >= 4 && bytes4(err) == want, what);
        passed++;
    }

    // ---------------------------------------------------------------- the setup

    function build(address singleton, address factory) internal {
        // T1: the custody Safe (all three custody signers) and the Prime account (2 of 3).
        custody = createSafe(singleton, factory, owners(custodyKeys), 3, 1);
        prime = createSafe(singleton, factory, owners(primeKeys), 2, 2);

        // T2: the Prime account configures its own Roles modifier: the agent's low band.
        bytes memory batch;
        (primeRoles, batch) = deployRoles(prime, "prime-roles");
        address gateAddr = predict(custody, "custody-gate");
        batch = abi.encodePacked(
            batch,
            entry(
                0,
                primeRoles,
                abi.encodeCall(
                    IRoles.setTransactionUnwrapper, (MULTISEND_CALL_ONLY, IMultiSend.multiSend.selector, UNWRAPPER)
                )
            ),
            entry(0, primeRoles, abi.encodeCall(IRoles.scopeTarget, (BAND, gateAddr))),
            entry(
                0,
                primeRoles,
                abi.encodeCall(
                    IRoles.scopeFunction, (BAND, gateAddr, IRoles.execTransactionWithRole.selector, bandSupply(), 0)
                )
            ),
            entry(0, primeRoles, abi.encodeCall(IRoles.scopeFunction, (BAND, gateAddr, RETURN_DATA, bandApprove(), 0))),
            entry(0, primeRoles, abi.encodeCall(IRoles.setAllowance, (AGENT_DAILY, 50e6, 50e6, 50e6, 1 days, 0))),
            entry(0, primeRoles, abi.encodeCall(IRoles.assignRoles, (agent, one(BAND), yes())))
        );
        check(
            execSafe(prime, MULTISEND, abi.encodeCall(IMultiSend.multiSend, (batch)), 1, some(primeKeys, 2)),
            "prime config"
        );

        // T3: custody configures its gate and the recovery timelock, signed by all three custody signers.
        timelock = new TimelockController(2 days, one(prime), one(address(0)), custody);
        (gate, batch) = deployRoles(custody, "custody-gate");
        batch = abi.encodePacked(batch, gateConfig());
        batch = abi.encodePacked(
            batch,
            entry(0, address(timelock), abi.encodeCall(timelock.grantRole, (timelock.CANCELLER_ROLE(), custody))),
            entry(0, address(timelock), abi.encodeCall(timelock.renounceRole, (timelock.DEFAULT_ADMIN_ROLE(), custody)))
        );
        check(
            execSafe(custody, MULTISEND, abi.encodeCall(IMultiSend.multiSend, (batch)), 1, all(custodyKeys)),
            "custody config"
        );
        check(gate == gateAddr, "gate address as predicted");

        vm.prank(USDC_MINTER);
        IERC20(USDC).mint(custody, 1_000e6);
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

    /// The custody gate: which venue calls the Prime account may make the custody Safe do.
    function gateConfig() internal view returns (bytes memory) {
        // approve(spender, amount): spender is the pool, amount under 1,000 per approval
        ConditionFlat[] memory approve = new ConditionFlat[](3);
        approve[0] = c(0, CALLDATA, MATCHES, "");
        approve[1] = c(0, STATIC, EQUAL_TO, abi.encode(POOL));
        approve[2] = c(0, STATIC, LESS_THAN, abi.encode(uint256(1_000e6 + 1)));
        // supply(asset, amount, onBehalfOf, referral): USDC, within custody's daily cap, on behalf of custody
        ConditionFlat[] memory supply = new ConditionFlat[](5);
        supply[0] = c(0, CALLDATA, MATCHES, "");
        supply[1] = c(0, STATIC, EQUAL_TO, abi.encode(USDC));
        supply[2] = c(0, STATIC, WITHIN_ALLOWANCE, abi.encode(CUSTODY_BUDGET));
        supply[3] = c(0, STATIC, EQUAL_TO_AVATAR, "");
        supply[4] = c(0, STATIC, PASS, "");
        // withdraw(asset, amount, to): USDC, to custody
        ConditionFlat[] memory withdraw = new ConditionFlat[](4);
        withdraw[0] = c(0, CALLDATA, MATCHES, "");
        withdraw[1] = c(0, STATIC, EQUAL_TO, abi.encode(USDC));
        withdraw[2] = c(0, STATIC, PASS, "");
        withdraw[3] = c(0, STATIC, EQUAL_TO_AVATAR, "");
        // recovery: transfer(to, amount) of USDC or aUSDC, and withdraw to the trustee only
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
                entry(0, gate, abi.encodeCall(IRoles.scopeFunction, (TRADE, POOL, IPool.supply.selector, supply, 0))),
                entry(
                    0, gate, abi.encodeCall(IRoles.scopeFunction, (TRADE, POOL, IPool.withdraw.selector, withdraw, 0))
                ),
                entry(0, gate, abi.encodeCall(IRoles.setAllowance, (CUSTODY_BUDGET, 200e6, 200e6, 200e6, 1 days, 0))),
                entry(0, gate, abi.encodeCall(IRoles.assignRoles, (prime, one(TRADE), yes())))
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
                entry(0, gate, abi.encodeCall(IRoles.assignRoles, (address(timelock), one(RECOVER), yes())))
            )
        );
    }

    /// The agent's low band on the Prime account, for the gate's execTransactionWithRole: one USDC supply of
    /// under 100 to the pool, within the agent's daily cap, through the trading role, with shouldRevert true.
    function bandSupply() internal pure returns (ConditionFlat[] memory b) {
        b = new ConditionFlat[](15);
        b[0] = c(0, CALLDATA, MATCHES, ""); // execTransactionWithRole(to, value, data, operation, roleKey, shouldRevert)
        b[1] = c(0, STATIC, EQUAL_TO, abi.encode(POOL)); // to
        b[2] = c(0, STATIC, EQUAL_TO, abi.encode(uint256(0))); // value
        b[3] = c(0, NONE, AND, ""); // data
        b[4] = c(0, STATIC, EQUAL_TO, abi.encode(uint256(0))); // operation: call
        b[5] = c(0, STATIC, EQUAL_TO, abi.encode(TRADE)); // role key
        b[6] = c(0, STATIC, EQUAL_TO, abi.encode(true)); // shouldRevert
        b[7] = c(3, CALLDATA, MATCHES, ""); // data is supply(asset, amount, onBehalfOf, referral)
        b[8] = c(3, DYNAMIC, BITMASK, selectorMask(IPool.supply.selector)); // and its selector is supply's
        b[9] = c(7, STATIC, EQUAL_TO, abi.encode(USDC));
        b[10] = c(7, NONE, AND, "");
        b[11] = c(7, STATIC, PASS, ""); // onBehalfOf: the gate pins it to custody
        b[12] = c(7, STATIC, PASS, "");
        b[13] = c(10, STATIC, LESS_THAN, abi.encode(uint256(100e6))); // under 100 per move
        b[14] = c(10, STATIC, WITHIN_ALLOWANCE, abi.encode(AGENT_DAILY)); // within the agent's daily cap
    }

    /// The same band, for the gate's execTransactionWithRoleReturnData: one USDC approval of the pool, under 100.
    /// Roles v2 needs every branch of an Or to share one parameter layout, so a band with calls of two layouts
    /// gives each layout its own gate entry point.
    function bandApprove() internal pure returns (ConditionFlat[] memory b) {
        b = new ConditionFlat[](11);
        b[0] = c(0, CALLDATA, MATCHES, "");
        b[1] = c(0, STATIC, EQUAL_TO, abi.encode(USDC));
        b[2] = c(0, STATIC, EQUAL_TO, abi.encode(uint256(0)));
        b[3] = c(0, NONE, AND, "");
        b[4] = c(0, STATIC, EQUAL_TO, abi.encode(uint256(0)));
        b[5] = c(0, STATIC, EQUAL_TO, abi.encode(TRADE));
        b[6] = c(0, STATIC, EQUAL_TO, abi.encode(true));
        b[7] = c(3, CALLDATA, MATCHES, ""); // approve(spender, amount)
        b[8] = c(3, DYNAMIC, BITMASK, selectorMask(IERC20.approve.selector));
        b[9] = c(7, STATIC, EQUAL_TO, abi.encode(POOL));
        b[10] = c(7, STATIC, LESS_THAN, abi.encode(uint256(100e6)));
    }

    // ---------------------------------------------------------------- calls

    function viaGate(address caller, address to, bytes memory data, uint8 op, bytes32 role)
        internal
        returns (bool ok, bytes memory err)
    {
        vm.prank(caller);
        (ok, err) = gate.call(abi.encodeCall(IRoles.execTransactionWithRole, (to, 0, data, op, role, true)));
    }

    function agentCall(address to, bytes memory data) internal returns (bool ok, bytes memory err) {
        bytes memory inner = abi.encodeCall(IRoles.execTransactionWithRole, (to, 0, data, 0, TRADE, true));
        vm.prank(agent);
        (ok, err) = primeRoles.call(abi.encodeCall(IRoles.execTransactionWithRole, (gate, 0, inner, 0, BAND, true)));
    }

    function agentBatch(bytes memory entries) internal returns (bool ok, bytes memory err) {
        vm.prank(agent);
        (ok, err) = primeRoles.call(
            abi.encodeCall(
                IRoles.execTransactionWithRole,
                (MULTISEND_CALL_ONLY, 0, abi.encodeCall(IMultiSend.multiSend, (entries)), 1, BAND, true)
            )
        );
    }

    function gateEntry(address to, bytes memory data) internal view returns (bytes memory) {
        if (bytes4(data) == IERC20.approve.selector) {
            return entry(0, gate, abi.encodeWithSelector(RETURN_DATA, to, 0, data, 0, TRADE, true));
        }
        return entry(0, gate, abi.encodeCall(IRoles.execTransactionWithRole, (to, 0, data, 0, TRADE, true)));
    }

    // ---------------------------------------------------------------- the run

    function run_(address singleton, address factory) internal {
        build(singleton, factory);
        string memory v = ISafe(custody).VERSION();
        v;
        check(
            IRoles(gate).owner() == custody && IRoles(gate).avatar() == custody && IRoles(gate).target() == custody,
            "gate wired to custody"
        );
        check(ISafe(custody).isModuleEnabled(gate), "gate enabled on custody");
        check(ISafe(prime).isModuleEnabled(primeRoles), "bands enabled on the Prime account");

        bytes memory sup10 = abi.encodeCall(IPool.supply, (USDC, 10e6, custody, 0));
        bytes memory app10 = abi.encodeCall(IERC20.approve, (POOL, 10e6));

        // 1. The agent: approve then supply 10 in one batch through its band. Funds go from custody to the pool,
        //    the position is custody's.
        uint256 usdc0 = IERC20(USDC).balanceOf(custody);
        uint256 a0 = IERC20(AUSDC).balanceOf(custody);
        uint256 g0 = gasleft();
        (bool ok, bytes memory err) = agentBatch(abi.encodePacked(gateEntry(USDC, app10), gateEntry(POOL, sup10)));
        emit log_move_gas(g0 - gasleft());
        check(ok, "agent batch approve + supply 10");
        check(IERC20(USDC).balanceOf(custody) == usdc0 - 10e6, "custody paid 10");
        check(IERC20(AUSDC).balanceOf(custody) + 2 >= a0 + 10e6, "custody holds the aUSDC");
        check(IERC20(USDC).balanceOf(prime) == 0 && IERC20(AUSDC).balanceOf(prime) == 0, "Prime account holds nothing");
        check(IERC20(USDC).balanceOf(agent) == 0, "agent holds nothing");

        // 2. Band refusals (the Prime account's rules)
        (ok, err) = agentCall(POOL, abi.encodeCall(IPool.supply, (USDC, 100e6, custody, 0)));
        refusedWith(ok, err, S_GREATER, "agent over its band (100)");
        (ok, err) = agentCall(POOL, abi.encodeCall(IPool.supply, (AUSDC, 1e6, custody, 0)));
        refusedWith(ok, err, S_PARAM, "agent supplying another asset");
        (ok, err) = agentCall(POOL, abi.encodeCall(IPool.withdraw, (USDC, 1e6, custody)));
        check(!ok, "agent calling a function its band does not list");
        (ok, err) = agentCall(POOL, abi.encodeWithSelector(IPool.withdraw.selector, USDC, 1e6, custody, 0));
        refusedWith(ok, err, S_BITMASK, "agent calling withdraw padded to supply's layout");
        (ok, err) = agentCall(stranger, sup10);
        refusedWith(ok, err, S_PARAM, "agent naming another target");
        // the daily cap: 40 more is within 50, then 1 more is not
        (ok, err) = agentBatch(
            abi.encodePacked(
                gateEntry(USDC, abi.encodeCall(IERC20.approve, (POOL, 40e6))),
                gateEntry(POOL, abi.encodeCall(IPool.supply, (USDC, 40e6, custody, 0)))
            )
        );
        check(ok, "agent at its daily cap (50)");
        (ok, err) = agentCall(POOL, abi.encodeCall(IPool.supply, (USDC, 1e6, custody, 0)));
        refusedWith(ok, err, S_ALLOWANCE, "agent over its daily cap");
        vm.warp(block.timestamp + 1 days);
        (ok, err) = agentBatch(abi.encodePacked(gateEntry(USDC, app10), gateEntry(POOL, sup10)));
        check(ok, "agent cap refilled after a day");
        // stranger, and a Prime owner's own key, are not members of the band
        vm.prank(stranger);
        (ok, err) = primeRoles.call(abi.encodeCall(IRoles.execTransactionWithRole, (gate, 0, "", 0, BAND, true)));
        check(!ok, "stranger on the band");

        // 3. Gate refusals (custody's rules), called as the Prime account itself (its owners at threshold)
        (ok, err) = viaGate(prime, POOL, abi.encodeCall(IPool.supply, (USDC, 10e6, stranger, 0)), 0, TRADE);
        refusedWith(ok, err, S_PARAM, "supply on behalf of a stranger");
        (ok, err) = viaGate(prime, POOL, abi.encodeCall(IPool.withdraw, (USDC, 1e6, stranger)), 0, TRADE);
        refusedWith(ok, err, S_PARAM, "withdraw to a stranger");
        (ok, err) = viaGate(prime, USDC, abi.encodeCall(IERC20.transfer, (stranger, 1e6)), 0, TRADE);
        refusedWith(ok, err, S_FUNCTION, "plain transfer out of custody");
        (ok, err) = viaGate(prime, USDC, abi.encodeCall(IERC20.approve, (stranger, 1e6)), 0, TRADE);
        refusedWith(ok, err, S_PARAM, "approval to a stranger");
        (ok, err) = viaGate(prime, AUSDC, abi.encodeCall(IERC20.transfer, (stranger, 1e6)), 0, TRADE);
        refusedWith(ok, err, S_TARGET, "aUSDC transfer");
        (ok, err) = viaGate(prime, POOL, abi.encodeCall(IPool.borrow, (USDC, 1e6, 2, 0, custody)), 0, TRADE);
        refusedWith(ok, err, S_FUNCTION, "borrow against custody's position");
        (ok, err) = viaGate(prime, POOL, sup10, 1, TRADE);
        refusedWith(ok, err, S_DELEGATECALL, "delegatecall from custody");
        (ok, err) = viaGate(prime, custody, abi.encodeCall(ISafe.addOwnerWithThreshold, (stranger, 1)), 0, TRADE);
        refusedWith(ok, err, S_TARGET, "custody Safe's own settings");
        (ok, err) = viaGate(prime, gate, abi.encodeCall(IRoles.assignRoles, (stranger, one(TRADE), yes())), 0, TRADE);
        refusedWith(ok, err, S_TARGET, "the gate's own settings through the gate");
        (ok, err) = viaGate(prime, USDC, abi.encodeCall(IERC20.transfer, (trustee, 1e6)), 0, RECOVER);
        refusedWithError(ok, err, bytes4(keccak256("NoMembership()")), "Prime account using the recovery role");
        vm.prank(prime);
        (ok, err) = gate.call(abi.encodeCall(IRoles.assignRoles, (stranger, one(TRADE), yes())));
        check(!ok, "Prime account changing the gate");
        vm.prank(agent);
        (ok, err) = gate.call(abi.encodeCall(IRoles.execTransactionWithRole, (POOL, 0, sup10, 0, TRADE, true)));
        check(!ok, "agent calling the gate directly");
        // custody's own daily cap: 200 a day, 10 used by the agent today; the Prime owners spend the rest
        (ok, err) = viaGate(prime, USDC, abi.encodeCall(IERC20.approve, (POOL, 1_000e6)), 0, TRADE);
        check(ok, "Prime owners approve the pool");
        (ok, err) = viaGate(prime, POOL, abi.encodeCall(IPool.supply, (USDC, 190e6, custody, 0)), 0, TRADE);
        check(ok, "Prime owners supply 190 (cap 200, 10 used today)");
        (ok, err) = viaGate(prime, POOL, abi.encodeCall(IPool.supply, (USDC, 1e6, custody, 0)), 0, TRADE);
        refusedWith(ok, err, S_ALLOWANCE, "custody's daily cap reached, even for the Prime owners");
        (ok, err) = viaGate(prime, POOL, abi.encodeCall(IPool.withdraw, (USDC, 5e6, custody)), 0, TRADE);
        check(ok, "withdraw 5 to custody");

        // 4. Recovery through the timelock: the Prime account schedules, custody can cancel, anyone runs it after
        //    the delay, and it pays the trustee only.
        bytes memory recoverCall = abi.encodeCall(
            IRoles.execTransactionWithRole,
            (AUSDC, 0, abi.encodeCall(IERC20.transfer, (trustee, 20e6)), 0, RECOVER, true)
        );
        bytes memory schedule =
            abi.encodeCall(timelock.schedule, (gate, 0, recoverCall, bytes32(0), bytes32("r1"), 2 days));
        vm.prank(stranger);
        (ok,) = address(timelock).call(schedule);
        check(!ok, "stranger cannot schedule a recovery");
        check(execSafe(prime, address(timelock), schedule, 0, some(primeKeys, 2)), "Prime owners schedule a recovery");
        vm.prank(stranger);
        (ok,) =
            address(timelock).call(abi.encodeCall(timelock.execute, (gate, 0, recoverCall, bytes32(0), bytes32("r1"))));
        check(!ok, "recovery before the delay");
        bytes32 id = timelock.hashOperation(gate, 0, recoverCall, bytes32(0), bytes32("r1"));
        check(
            execSafe(custody, address(timelock), abi.encodeCall(timelock.cancel, (id)), 0, all(custodyKeys)),
            "custody cancels it"
        );
        vm.warp(block.timestamp + 2 days + 1);
        vm.prank(stranger);
        (ok,) =
            address(timelock).call(abi.encodeCall(timelock.execute, (gate, 0, recoverCall, bytes32(0), bytes32("r1"))));
        check(!ok, "a cancelled recovery never runs");
        schedule = abi.encodeCall(timelock.schedule, (gate, 0, recoverCall, bytes32(0), bytes32("r2"), 2 days));
        check(execSafe(prime, address(timelock), schedule, 0, some(primeKeys, 2)), "Prime owners schedule again");
        vm.warp(block.timestamp + 2 days + 1);
        uint256 t0 = IERC20(AUSDC).balanceOf(trustee);
        vm.prank(stranger);
        (ok,) =
            address(timelock).call(abi.encodeCall(timelock.execute, (gate, 0, recoverCall, bytes32(0), bytes32("r2"))));
        check(ok, "anyone runs the recovery after the delay");
        check(IERC20(AUSDC).balanceOf(trustee) + 2 >= t0 + 20e6, "trustee received 20 aUSDC");
        bytes memory toStranger = abi.encodeCall(
            IRoles.execTransactionWithRole,
            (USDC, 0, abi.encodeCall(IERC20.transfer, (stranger, 1e6)), 0, RECOVER, true)
        );
        schedule = abi.encodeCall(timelock.schedule, (gate, 0, toStranger, bytes32(0), bytes32("r3"), 2 days));
        check(
            execSafe(prime, address(timelock), schedule, 0, some(primeKeys, 2)),
            "a recovery to a stranger can be scheduled"
        );
        vm.warp(block.timestamp + 2 days + 1);
        (ok,) =
            address(timelock).call(abi.encodeCall(timelock.execute, (gate, 0, toStranger, bytes32(0), bytes32("r3"))));
        check(!ok, "but the gate refuses to pay a stranger");
        (ok,) = address(timelock)
            .call(
                abi.encodeCall(
                    timelock.schedule,
                    (address(timelock), 0, abi.encodeCall(timelock.updateDelay, (0)), bytes32(0), bytes32("d"), 0)
                )
            );
        check(!ok, "nobody shortens the delay directly");

        // 5. Stopping it: custody revokes the Prime account's membership (trading stops, recovery stays),
        //    then turns the gate off (everything stops), each in one transaction of custody's own.
        check(
            execSafe(custody, gate, abi.encodeCall(IRoles.assignRoles, (prime, one(TRADE), no())), 0, all(custodyKeys)),
            "custody revokes the trading role"
        );
        (ok, err) = agentBatch(abi.encodePacked(gateEntry(USDC, app10), gateEntry(POOL, sup10)));
        check(!ok, "agent stopped");
        (ok, err) = viaGate(prime, POOL, abi.encodeCall(IPool.withdraw, (USDC, 1e6, custody)), 0, TRADE);
        refusedWithError(ok, err, bytes4(keccak256("NoMembership()")), "Prime owners stopped");
        check(
            execSafe(custody, custody, abi.encodeCall(ISafe.disableModule, (address(1), gate)), 0, all(custodyKeys)),
            "custody disables the gate"
        );
        bytes memory recoverUsdc = abi.encodeCall(
            IRoles.execTransactionWithRole, (USDC, 0, abi.encodeCall(IERC20.transfer, (trustee, 1e6)), 0, RECOVER, true)
        );
        schedule = abi.encodeCall(timelock.schedule, (gate, 0, recoverUsdc, bytes32(0), bytes32("r4"), 2 days));
        check(execSafe(prime, address(timelock), schedule, 0, some(primeKeys, 2)), "schedule during a full stop");
        vm.warp(block.timestamp + 2 days + 1);
        (ok,) =
            address(timelock).call(abi.encodeCall(timelock.execute, (gate, 0, recoverUsdc, bytes32(0), bytes32("r4"))));
        check(!ok, "recovery cannot run while the gate is off (GS104)");
        // two of three custody signers cannot act
        bool reverted;
        try this.execExternal(custody, custody, abi.encodeCall(ISafe.enableModule, (gate)), some(custodyKeys, 2)) {}
        catch {
            reverted = true;
        }
        check(reverted, "two of three custody signers refused");
        // one Prime owner alone cannot schedule
        reverted = false;
        try this.execExternal(prime, address(timelock), schedule, some(primeKeys, 1)) {}
        catch {
            reverted = true;
        }
        check(reverted, "one Prime owner refused");
    }

    function execExternal(address safe, address to, bytes memory data, uint256[] memory keys) external {
        require(msg.sender == address(this));
        execSafe(safe, to, data, 0, keys);
    }

    function test_configOnly_safe141() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        run_(SAFE_141, FACTORY_141);
        require(passed > 50, "count");
        emit log_count(passed);
    }

    function test_configOnly_safe150() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        run_(SAFE_150, FACTORY_150);
        require(passed > 50, "count");
        emit log_count(passed);
    }

    event log_count(uint256);
    event log_move_gas(uint256);
}
