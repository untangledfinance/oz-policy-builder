// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

// The live state the evm_review readChain tests replay: Prime on EVM in the move-timelock shape,
// built on a LOCAL anvil fork of Base Sepolia, never on a network. It follows the setup of
// scripts/evm-config-check/test/ConfigOnly.t.sol (T1: the custody Safe 3 of 3 and the Prime account
// 2 of 3; T2: the Prime account's Roles modifier and the agent's band; T3: the custody gate, its
// trading and recovery roles and their timelocks), with the agent's moves routed through a move
// timelock TLx (OpenZeppelin TimelockController 5.6.0): the gate's trading role's member is TLx, the
// Prime account proposes, anyone executes, the Prime account and custody cancel, and the agent's
// band scopes TLx.schedule of the gate's execTransactionWithRole. Signed by the owners' keys and
// sent as Safe transactions; plus a test double of an ERC-3643 token (its identity registry and
// freeze state) for the permissioned-token read, deployed on the fork only.
//
//   anvil --fork-url https://sepolia.base.org --fork-block-number 50991000
//   forge script Setup.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key <anvil key 0>
//
// Writes the addresses to out-state/addresses.json. NO_RENOUNCE=1 leaves the custody Safe holding
// the timelock's admin role (a setup that skipped the renounce).

interface Vm {
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function addr(uint256) external returns (address);
    function envOr(string calldata, bool) external returns (bool);
    function startBroadcast() external;
    function stopBroadcast() external;
    function writeFile(string calldata, string calldata) external;
    function toString(address) external pure returns (string memory);
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
    function assignRoles(address, bytes32[] calldata, bool[] calldata) external;
    function scopeTarget(bytes32, address) external;
    function scopeFunction(bytes32, address, bytes4, ConditionFlat[] memory, uint8) external;
    function setAllowance(bytes32, uint128, uint128, uint128, uint64, uint64) external;
    function setTransactionUnwrapper(address, bytes4, address) external;
    function execTransactionWithRole(address, uint256, bytes calldata, uint8, bytes32, bool) external returns (bool);
}

interface IERC20 {
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

interface IPool {
    function supply(address, uint256, address, uint16) external;
    function withdraw(address, uint256, address) external returns (uint256);
}

/// Test double: an ERC-3643 identity registry (who is verified).
contract MockIdentityRegistry {
    address public immutable agent = msg.sender;
    mapping(address => bool) public isVerified;

    function setVerified(address a, bool v) external {
        require(msg.sender == agent, "agent");
        isVerified[a] = v;
    }
}

/// Test double: the ERC-3643 views a pre-sign read asks of a permissioned token.
contract MockERC3643 {
    address public immutable agent = msg.sender;
    address public immutable identityRegistry;
    address public constant compliance = address(0xC0C0);
    bool public paused;
    mapping(address => bool) public isFrozen;
    mapping(address => uint256) public getFrozenTokens;
    mapping(address => uint256) public balanceOf;

    constructor(address registry) {
        identityRegistry = registry;
    }

    function setAddressFrozen(address a, bool f) external {
        require(msg.sender == agent, "agent");
        isFrozen[a] = f;
    }

    function freezePartialTokens(address a, uint256 n) external {
        require(msg.sender == agent, "agent");
        getFrozenTokens[a] = n;
    }

    function pause() external {
        require(msg.sender == agent, "agent");
        paused = true;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }
}

contract Setup {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address constant SAFE_141 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address constant FACTORY_141 = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant MULTISEND = 0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526;
    address constant MULTISEND_CALL_ONLY = 0x9641d764fc13c8B624c04430C7356C1C7C8102e2;
    address constant CREATE_CALL = 0x9b35Af71d77eaf8d7e40252370304687390A1A52;
    address constant ROLES = 0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5;
    address constant UNWRAPPER = 0x93B7fCbc63ED8a3a24B59e1C3e6649D50B7427c0;
    address constant POOL = 0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27;
    address constant USDC = 0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f;
    address constant AUSDC = 0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC;

    uint8 constant NONE = 0;
    uint8 constant STATIC = 1;
    uint8 constant DYNAMIC = 2;
    uint8 constant CALLDATA = 5;
    uint8 constant PASS = 0;
    uint8 constant AND = 1;
    uint8 constant MATCHES = 5;
    uint8 constant EQUAL_TO_AVATAR = 15;
    uint8 constant EQUAL_TO = 16;
    uint8 constant LESS_THAN = 18;
    uint8 constant BITMASK = 21;
    uint8 constant WITHIN_ALLOWANCE = 28;

    bytes4 constant RETURN_DATA =
        bytes4(keccak256("execTransactionWithRoleReturnData(address,uint256,bytes,uint8,bytes32,bool)"));
    bytes32 constant TRADE = "prime-trading";
    bytes32 constant RECOVER = "recovery";
    bytes32 constant BAND = "agent-low";
    bytes32 constant CUSTODY_BUDGET = "custody-daily";
    bytes32 constant AGENT_DAILY = "agent-daily";

    uint256[3] custodyKeys = [uint256(0xC1), 0xC2, 0xC3];
    uint256[3] primeKeys = [uint256(0xB1), 0xB2, 0xB3];
    uint256 constant AGENT_KEY = 0xA1;
    address trustee = address(0x7157EE);

    address custody;
    address gate;
    address prime;
    address primeRoles;
    TimelockController timelock;
    TimelockController moves;
    MockIdentityRegistry registry;
    MockERC3643 token;

    function run() external {
        vm.startBroadcast();
        custody = createSafe(owners(custodyKeys), 3, 1);
        prime = createSafe(owners(primeKeys), 2, 2);

        bytes memory batch;
        (primeRoles, batch) = deployRoles(prime, "prime-roles");
        address gateAddr = predict(custody, "custody-gate");
        moves = new TimelockController(1 hours, oneAddr(prime), oneAddr(address(0)), custody);
        batch = abi.encodePacked(
            batch,
            entry(
                0,
                primeRoles,
                abi.encodeCall(
                    IRoles.setTransactionUnwrapper, (MULTISEND_CALL_ONLY, IMultiSend.multiSend.selector, UNWRAPPER)
                )
            ),
            entry(0, primeRoles, abi.encodeCall(IRoles.scopeTarget, (BAND, address(moves)))),
            entry(
                0,
                primeRoles,
                abi.encodeCall(
                    IRoles.scopeFunction, (BAND, address(moves), moves.schedule.selector, bandSchedule(gateAddr), 0)
                )
            ),
            entry(0, primeRoles, abi.encodeCall(IRoles.setAllowance, (AGENT_DAILY, 50e6, 50e6, 50e6, 1 days, 0))),
            entry(0, primeRoles, abi.encodeCall(IRoles.assignRoles, (vm.addr(AGENT_KEY), one(BAND), yes())))
        );
        require(execSafe(prime, abi.encodeCall(IMultiSend.multiSend, (batch)), some(primeKeys, 2)), "prime config");

        timelock = new TimelockController(2 days, oneAddr(prime), oneAddr(address(0)), custody);
        (gate, batch) = deployRoles(custody, "custody-gate");
        batch = abi.encodePacked(batch, gateConfig());
        batch = abi.encodePacked(
            batch,
            entry(0, address(timelock), abi.encodeCall(timelock.grantRole, (timelock.CANCELLER_ROLE(), custody))),
            entry(0, address(moves), abi.encodeCall(moves.grantRole, (moves.CANCELLER_ROLE(), custody))),
            entry(0, address(moves), abi.encodeCall(moves.renounceRole, (moves.DEFAULT_ADMIN_ROLE(), custody)))
        );
        if (!vm.envOr("NO_RENOUNCE", false)) {
            batch = abi.encodePacked(
                batch,
                entry(
                    0, address(timelock), abi.encodeCall(timelock.renounceRole, (timelock.DEFAULT_ADMIN_ROLE(), custody))
                )
            );
        }
        require(execSafe(custody, abi.encodeCall(IMultiSend.multiSend, (batch)), all(custodyKeys)), "custody config");
        require(gate == gateAddr, "gate address");

        registry = new MockIdentityRegistry();
        token = new MockERC3643(address(registry));
        registry.setVerified(custody, true);
        vm.stopBroadcast();

        string memory json = string.concat(
            '{"custody":"',
            vm.toString(custody),
            '","prime":"',
            vm.toString(prime),
            '","gate":"',
            vm.toString(gate),
            '","primeRoles":"',
            vm.toString(primeRoles),
            '","timelock":"',
            vm.toString(address(timelock)),
            '","moves":"',
            vm.toString(address(moves)),
            '","registry":"',
            vm.toString(address(registry)),
            '","token":"',
            vm.toString(address(token)),
            '","trustee":"',
            vm.toString(trustee),
            '","agent":"',
            vm.toString(vm.addr(AGENT_KEY)),
            '"}'
        );
        vm.writeFile("out-state/addresses.json", json);
    }

    function owners(uint256[3] storage keys) internal returns (address[] memory list) {
        list = new address[](3);
        for (uint256 i; i < 3; i++) {
            list[i] = vm.addr(keys[i]);
        }
    }

    function createSafe(address[] memory list, uint256 threshold, uint256 salt) internal returns (address) {
        bytes memory init =
            abi.encodeCall(ISafe.setup, (list, threshold, address(0), "", address(0), address(0), 0, address(0)));
        return IProxyFactory(FACTORY_141).createProxyWithNonce(SAFE_141, init, salt);
    }

    function execSafe(address safe, bytes memory data, uint256[] memory keys) internal returns (bool) {
        bytes32 h = ISafe(safe)
            .getTransactionHash(MULTISEND, 0, data, 1, 0, 0, 0, address(0), address(0), ISafe(safe).nonce());
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
        return ISafe(safe).execTransaction(MULTISEND, 0, data, 1, 0, 0, 0, address(0), address(0), sigs);
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

    function one(bytes32 k) internal pure returns (bytes32[] memory l) {
        l = new bytes32[](1);
        l[0] = k;
    }

    function oneAddr(address a) internal pure returns (address[] memory l) {
        l = new address[](1);
        l[0] = a;
    }

    function yes() internal pure returns (bool[] memory l) {
        l = new bool[](1);
        l[0] = true;
    }

    function gateConfig() internal view returns (bytes memory) {
        ConditionFlat[] memory approve = new ConditionFlat[](3);
        approve[0] = c(0, CALLDATA, MATCHES, "");
        approve[1] = c(0, STATIC, EQUAL_TO, abi.encode(POOL));
        approve[2] = c(0, STATIC, LESS_THAN, abi.encode(uint256(1_000e6 + 1)));
        ConditionFlat[] memory supply = new ConditionFlat[](5);
        supply[0] = c(0, CALLDATA, MATCHES, "");
        supply[1] = c(0, STATIC, EQUAL_TO, abi.encode(USDC));
        supply[2] = c(0, STATIC, WITHIN_ALLOWANCE, abi.encode(CUSTODY_BUDGET));
        supply[3] = c(0, STATIC, EQUAL_TO_AVATAR, "");
        supply[4] = c(0, STATIC, PASS, "");
        ConditionFlat[] memory withdraw = new ConditionFlat[](4);
        withdraw[0] = c(0, CALLDATA, MATCHES, "");
        withdraw[1] = c(0, STATIC, EQUAL_TO, abi.encode(USDC));
        withdraw[2] = c(0, STATIC, PASS, "");
        withdraw[3] = c(0, STATIC, EQUAL_TO_AVATAR, "");
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
                entry(0, gate, abi.encodeCall(IRoles.assignRoles, (address(timelock), one(RECOVER), yes())))
            )
        );
    }

    /// The agent's band: TLx.schedule(target, value, data, predecessor, salt, delay) of one gate call,
    /// execTransactionWithRole(POOL, 0, supply(USDC, under 100 within agent-daily, custody, 0), call,
    /// TRADE, shouldRevert), each selector pinned by a Bitmask.
    function bandSchedule(address gateAddr) internal pure returns (ConditionFlat[] memory b) {
        b = new ConditionFlat[](23);
        b[0] = c(0, CALLDATA, MATCHES, "");
        b[1] = c(0, STATIC, EQUAL_TO, abi.encode(gateAddr));
        b[2] = c(0, STATIC, EQUAL_TO, abi.encode(uint256(0)));
        b[3] = c(0, NONE, AND, "");
        b[4] = c(0, STATIC, PASS, "");
        b[5] = c(0, STATIC, PASS, "");
        b[6] = c(0, STATIC, PASS, "");
        b[7] = c(3, CALLDATA, MATCHES, "");
        b[8] = c(3, DYNAMIC, BITMASK, selectorMask(IRoles.execTransactionWithRole.selector));
        b[9] = c(7, STATIC, EQUAL_TO, abi.encode(POOL));
        b[10] = c(7, STATIC, EQUAL_TO, abi.encode(uint256(0)));
        b[11] = c(7, NONE, AND, "");
        b[12] = c(7, STATIC, EQUAL_TO, abi.encode(uint256(0)));
        b[13] = c(7, STATIC, EQUAL_TO, abi.encode(TRADE));
        b[14] = c(7, STATIC, EQUAL_TO, abi.encode(true));
        b[15] = c(11, CALLDATA, MATCHES, "");
        b[16] = c(11, DYNAMIC, BITMASK, selectorMask(IPool.supply.selector));
        b[17] = c(15, STATIC, EQUAL_TO, abi.encode(USDC));
        b[18] = c(15, NONE, AND, "");
        b[19] = c(15, STATIC, PASS, "");
        b[20] = c(15, STATIC, PASS, "");
        b[21] = c(18, STATIC, LESS_THAN, abi.encode(uint256(100e6)));
        b[22] = c(18, STATIC, WITHIN_ALLOWANCE, abi.encode(AGENT_DAILY));
    }
}
