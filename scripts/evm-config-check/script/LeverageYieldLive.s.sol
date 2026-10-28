// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    ISafe,
    IProxyFactory,
    ICreateCall,
    IMultiSend,
    ConditionFlat,
    IRoles,
    IERC20,
    IPool,
    IVault,
    MockVault
} from "../test/LeverageYield.t.sol";

// The live run of the leverage-yield execution adapter on Base Sepolia. It builds the custody Safe,
// the gate and the leverage-yield policy template, deploys the MockVault fixture, mints the test
// assets through the Aave faucet, then runs a real OPEN and a real CLOSE through the gate's Roles
// MultiSend path. Every contract it uses is existing code (Safe proxies, Zodiac Roles v2.1.1 proxies)
// except MockVault, a test fixture. The encoders are copied from test/LeverageYield.t.sol, which
// proves them on a fork. The refusals are sent separately with cast (so a reverting transaction lands
// on chain). Run: forge script script/LeverageYieldLive.s.sol --rpc-url <base-sepolia> --broadcast
// --private-key <deployer>. The deployer is the gate's leverage-yield member (the scoped agent).

interface VmS {
    function envUint(string calldata) external view returns (uint256);
    function addr(uint256) external view returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function startBroadcast(uint256) external;
    function stopBroadcast() external;
    function writeFile(string calldata, string calldata) external;
    function toString(address) external pure returns (string memory);
    function toString(uint256) external pure returns (string memory);
}

interface IFaucet {
    function mint(address token, address to, uint256 amount) external returns (uint256);
}

contract LeverageYieldLive {
    VmS constant vm = VmS(address(uint160(uint256(keccak256("hevm cheat code")))));

    address constant SAFE_141 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address constant FACTORY_141 = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant MULTISEND = 0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526;
    address constant MULTISEND_CALL_ONLY = 0x9641d764fc13c8B624c04430C7356C1C7C8102e2;
    address constant CREATE_CALL = 0x9b35Af71d77eaf8d7e40252370304687390A1A52;
    address constant ROLES = 0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5;
    address constant UNWRAPPER = 0x93B7fCbc63ED8a3a24B59e1C3e6649D50B7427c0;

    address constant POOL = 0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27;
    address constant GOLD_TOKEN = 0xD171b9694f7A2597Ed006D41f7509aaD4B485c4B; // cbETH
    address constant USDC = 0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f;
    address constant FAUCET = 0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc;

    uint8 constant NONE = 0;
    uint8 constant STATIC = 1;
    uint8 constant CALLDATA = 5;
    uint8 constant PASS = 0;
    uint8 constant OR = 2;
    uint8 constant MATCHES = 5;
    uint8 constant EQUAL_TO_AVATAR = 15;
    uint8 constant EQUAL_TO = 16;
    uint8 constant WITHIN_ALLOWANCE = 28;

    bytes32 constant LEVERAGE = "leverage-yield";
    bytes32 constant BORROW_CAP = "leverage-borrow";

    uint256 constant VARIABLE = 2;
    uint256 constant GOLD_AMT = 5e17; // 0.5 cbETH
    uint256 constant BORROW = 500e6; // 500 USDC
    uint256 constant CAP = 2_000e6; // the signed borrow ceiling

    uint256[3] custodyKeys = [uint256(0xC1), 0xC2, 0xC3];

    address deployer; // the funded key; also the gate's leverage-yield member (the scoped agent)
    address custody;
    address gate;
    MockVault vault;

    function owners() internal view returns (address[] memory list) {
        list = new address[](3);
        for (uint256 i; i < 3; i++) {
            list[i] = vm.addr(custodyKeys[i]);
        }
    }

    function entry(uint8 op, address to, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(op, to, uint256(0), data.length, data);
    }

    function proxyCode() internal pure returns (bytes memory) {
        return
            abi.encodePacked(hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", ROLES, hex"5af43d82803e903d91602b57fd5bf3");
    }

    function predict(address d, bytes32 salt) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), d, salt, keccak256(proxyCode()))))));
    }

    function c(uint8 parent, uint8 pt, uint8 op, bytes memory comp) internal pure returns (ConditionFlat memory) {
        return ConditionFlat(parent, pt, op, comp);
    }

    function oneB(bytes32 k) internal pure returns (bytes32[] memory l) {
        l = new bytes32[](1);
        l[0] = k;
    }

    function yes() internal pure returns (bool[] memory l) {
        l = new bool[](1);
        l[0] = true;
    }

    // The leverage-yield template, identical in shape to test/LeverageYield.t.sol, with the deployer as
    // the sole member (the scoped agent). The Prime-account member path is proven on the fork.
    function leverageConfig() internal view returns (bytes memory) {
        ConditionFlat[] memory goldApprove = new ConditionFlat[](3);
        goldApprove[0] = c(0, CALLDATA, MATCHES, "");
        goldApprove[1] = c(0, STATIC, EQUAL_TO, abi.encode(POOL));
        goldApprove[2] = c(0, STATIC, PASS, "");

        ConditionFlat[] memory stableApprove = new ConditionFlat[](5);
        stableApprove[0] = c(0, CALLDATA, MATCHES, "");
        stableApprove[1] = c(0, NONE, OR, "");
        stableApprove[2] = c(0, STATIC, PASS, "");
        stableApprove[3] = c(1, STATIC, EQUAL_TO, abi.encode(POOL));
        stableApprove[4] = c(1, STATIC, EQUAL_TO, abi.encode(address(vault)));

        ConditionFlat[] memory supply = new ConditionFlat[](5);
        supply[0] = c(0, CALLDATA, MATCHES, "");
        supply[1] = c(0, STATIC, EQUAL_TO, abi.encode(GOLD_TOKEN));
        supply[2] = c(0, STATIC, PASS, "");
        supply[3] = c(0, STATIC, EQUAL_TO_AVATAR, "");
        supply[4] = c(0, STATIC, PASS, "");

        ConditionFlat[] memory borrow = new ConditionFlat[](6);
        borrow[0] = c(0, CALLDATA, MATCHES, "");
        borrow[1] = c(0, STATIC, EQUAL_TO, abi.encode(USDC));
        borrow[2] = c(0, STATIC, WITHIN_ALLOWANCE, abi.encode(BORROW_CAP));
        borrow[3] = c(0, STATIC, EQUAL_TO, abi.encode(VARIABLE));
        borrow[4] = c(0, STATIC, PASS, "");
        borrow[5] = c(0, STATIC, EQUAL_TO_AVATAR, "");

        ConditionFlat[] memory deposit = new ConditionFlat[](3);
        deposit[0] = c(0, CALLDATA, MATCHES, "");
        deposit[1] = c(0, STATIC, PASS, "");
        deposit[2] = c(0, STATIC, EQUAL_TO_AVATAR, "");

        ConditionFlat[] memory redeem = new ConditionFlat[](4);
        redeem[0] = c(0, CALLDATA, MATCHES, "");
        redeem[1] = c(0, STATIC, PASS, "");
        redeem[2] = c(0, STATIC, EQUAL_TO_AVATAR, "");
        redeem[3] = c(0, STATIC, EQUAL_TO_AVATAR, "");

        ConditionFlat[] memory repay = new ConditionFlat[](5);
        repay[0] = c(0, CALLDATA, MATCHES, "");
        repay[1] = c(0, STATIC, EQUAL_TO, abi.encode(USDC));
        repay[2] = c(0, STATIC, PASS, "");
        repay[3] = c(0, STATIC, EQUAL_TO, abi.encode(VARIABLE));
        repay[4] = c(0, STATIC, EQUAL_TO_AVATAR, "");

        ConditionFlat[] memory withdraw = new ConditionFlat[](4);
        withdraw[0] = c(0, CALLDATA, MATCHES, "");
        withdraw[1] = c(0, STATIC, EQUAL_TO, abi.encode(GOLD_TOKEN));
        withdraw[2] = c(0, STATIC, PASS, "");
        withdraw[3] = c(0, STATIC, EQUAL_TO_AVATAR, "");

        bytes memory tokens = abi.encodePacked(
            entry(0, gate, abi.encodeCall(IRoles.setTransactionUnwrapper, (MULTISEND_CALL_ONLY, IMultiSend.multiSend.selector, UNWRAPPER))),
            entry(0, gate, abi.encodeCall(IRoles.scopeTarget, (LEVERAGE, GOLD_TOKEN))),
            entry(0, gate, abi.encodeCall(IRoles.scopeFunction, (LEVERAGE, GOLD_TOKEN, IERC20.approve.selector, goldApprove, 0))),
            entry(0, gate, abi.encodeCall(IRoles.scopeTarget, (LEVERAGE, USDC))),
            entry(0, gate, abi.encodeCall(IRoles.scopeFunction, (LEVERAGE, USDC, IERC20.approve.selector, stableApprove, 0)))
        );
        bytes memory poolScopes = abi.encodePacked(
            entry(0, gate, abi.encodeCall(IRoles.scopeTarget, (LEVERAGE, POOL))),
            entry(0, gate, abi.encodeCall(IRoles.scopeFunction, (LEVERAGE, POOL, IPool.supply.selector, supply, 0))),
            entry(0, gate, abi.encodeCall(IRoles.scopeFunction, (LEVERAGE, POOL, IPool.borrow.selector, borrow, 0))),
            entry(0, gate, abi.encodeCall(IRoles.scopeFunction, (LEVERAGE, POOL, IPool.repay.selector, repay, 0))),
            entry(0, gate, abi.encodeCall(IRoles.scopeFunction, (LEVERAGE, POOL, IPool.withdraw.selector, withdraw, 0)))
        );
        bytes memory vaultScopes = abi.encodePacked(
            entry(0, gate, abi.encodeCall(IRoles.scopeTarget, (LEVERAGE, address(vault)))),
            entry(0, gate, abi.encodeCall(IRoles.scopeFunction, (LEVERAGE, address(vault), IVault.deposit.selector, deposit, 0))),
            entry(0, gate, abi.encodeCall(IRoles.scopeFunction, (LEVERAGE, address(vault), IVault.redeem.selector, redeem, 0))),
            entry(0, gate, abi.encodeCall(IRoles.setAllowance, (BORROW_CAP, uint128(CAP), uint128(CAP), uint128(CAP), 1 days, 0))),
            entry(0, gate, abi.encodeCall(IRoles.assignRoles, (deployer, oneB(LEVERAGE), yes())))
        );
        return abi.encodePacked(tokens, poolScopes, vaultScopes);
    }

    function deployRoles(bytes32 salt) internal view returns (address roles, bytes memory batch) {
        roles = predict(custody, salt);
        batch = abi.encodePacked(
            entry(1, CREATE_CALL, abi.encodeCall(ICreateCall.performCreate2, (0, proxyCode(), salt))),
            entry(0, roles, abi.encodeCall(IRoles.setUp, (abi.encode(custody, custody, custody)))),
            entry(0, custody, abi.encodeCall(ISafe.enableModule, (roles)))
        );
    }

    function openBatch() internal view returns (bytes memory) {
        return abi.encodePacked(
            entry(0, GOLD_TOKEN, abi.encodeCall(IERC20.approve, (POOL, GOLD_AMT))),
            entry(0, POOL, abi.encodeCall(IPool.supply, (GOLD_TOKEN, GOLD_AMT, custody, 0))),
            entry(0, POOL, abi.encodeCall(IPool.borrow, (USDC, BORROW, VARIABLE, 0, custody))),
            entry(0, USDC, abi.encodeCall(IERC20.approve, (address(vault), BORROW))),
            entry(0, address(vault), abi.encodeCall(IVault.deposit, (BORROW, custody)))
        );
    }

    function closeBatch(uint256 shares) internal view returns (bytes memory) {
        return abi.encodePacked(
            entry(0, address(vault), abi.encodeCall(IVault.redeem, (shares, custody, custody))),
            entry(0, USDC, abi.encodeCall(IERC20.approve, (POOL, type(uint256).max))),
            entry(0, POOL, abi.encodeCall(IPool.repay, (USDC, type(uint256).max, VARIABLE, custody))),
            entry(0, POOL, abi.encodeCall(IPool.withdraw, (GOLD_TOKEN, type(uint256).max, custody)))
        );
    }

    function execSafe(address safe, address to, bytes memory data, uint8 op) internal {
        uint256[] memory keys = new uint256[](3);
        for (uint256 i; i < 3; i++) {
            keys[i] = custodyKeys[i];
        }
        bytes32 h = ISafe(safe).getTransactionHash(to, 0, data, op, 0, 0, 0, address(0), address(0), ISafe(safe).nonce());
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
        ISafe(safe).execTransaction(to, 0, data, op, 0, 0, 0, address(0), address(0), sigs);
    }

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        deployer = vm.addr(pk);
        bytes32 salt = keccak256(abi.encodePacked("leverage-yield-live", deployer)); // unique per deployer

        vm.startBroadcast(pk);

        // T1: the custody Safe (3 of 3)
        bytes memory init =
            abi.encodeCall(ISafe.setup, (owners(), 3, address(0), "", address(0), address(0), 0, address(0)));
        custody = IProxyFactory(FACTORY_141).createProxyWithNonce(SAFE_141, init, uint256(salt));

        // the yield source fixture
        vault = new MockVault(USDC);

        // T3: the gate and the leverage-yield template, signed by the three custody signers
        bytes memory batch;
        (gate, batch) = deployRoles("leverage-gate");
        batch = abi.encodePacked(batch, leverageConfig());
        execSafe(custody, MULTISEND, abi.encodeCall(IMultiSend.multiSend, (batch)), 1);

        // mint the gold stand-in to custody, and the vault's standing yield
        IFaucet(FAUCET).mint(GOLD_TOKEN, custody, 1e18);
        IFaucet(FAUCET).mint(USDC, address(vault), 100e6);

        // OPEN: supply gold + borrow stable + deposit yield, one atomic MultiSend through the gate
        IRoles(gate).execTransactionWithRole(
            MULTISEND_CALL_ONLY, 0, abi.encodeCall(IMultiSend.multiSend, (openBatch())), 1, LEVERAGE, true
        );

        // CLOSE: redeem all shares + repay-max + withdraw-max
        uint256 shares = IERC20(address(vault)).balanceOf(custody);
        IRoles(gate).execTransactionWithRole(
            MULTISEND_CALL_ONLY, 0, abi.encodeCall(IMultiSend.multiSend, (closeBatch(shares))), 1, LEVERAGE, true
        );

        vm.stopBroadcast();

        // record the addresses for the driver and the evidence
        string memory out = string.concat(
            '{"deployer":"', vm.toString(deployer), '","custody":"', vm.toString(custody), '","gate":"',
            vm.toString(gate), '","vault":"', vm.toString(address(vault)), '","gold":"', vm.toString(GOLD_TOKEN),
            '","usdc":"', vm.toString(USDC), '","shares":"', vm.toString(shares), '"}'
        );
        vm.writeFile("refline/leverage-live-addresses.json", out);
    }
}
