// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISafe, IProxyFactory, ICreateCall, MockVault} from "../test/LeverageYield.t.sol";
import {
    IRoles, IMultiSend, IERC20, LeverageYieldParams, LeverageYieldTemplate as T
} from "../test/LeverageYieldTemplate.sol";

// The live run of the leverage-yield execution adapter on Base Sepolia. It builds the custody Safe,
// the gate and the leverage-yield policy template, deploys the MockVault fixture, mints the test
// assets through the Aave faucet, then runs a real OPEN and a real CLOSE through the gate's Roles
// MultiSend path. Every contract it uses is existing code (Safe proxies, Zodiac Roles v2.1.1 proxies)
// except MockVault, a test fixture. The scopes and the batches come from test/LeverageYieldTemplate.sol,
// the same builder the fork test proves. The refusals are sent separately with cast (so a reverting
// transaction lands on chain). Run: forge script script/LeverageYieldLive.s.sol --rpc-url <base-sepolia>
// --broadcast --private-key <deployer>. The deployer is the template's one user member; no agent is
// installed (the agent's role is proven on the fork). The recorded run of 28 October 2026 predates the
// builder and used one role for both members.

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
    address constant CREATE_CALL = 0x9b35Af71d77eaf8d7e40252370304687390A1A52;
    address constant ROLES = 0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5;

    address constant POOL = 0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27;
    address constant GOLD_TOKEN = 0xD171b9694f7A2597Ed006D41f7509aaD4B485c4B; // cbETH
    address constant USDC = 0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f;
    address constant FAUCET = 0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc;

    uint256 constant GOLD_AMT = 5e17; // 0.5 cbETH
    uint256 constant BORROW = 500e6; // 500 USDC
    uint256 constant CAP = 2_000e6; // the signed borrow ceiling

    uint256[3] custodyKeys = [uint256(0xC1), 0xC2, 0xC3];

    address deployer; // the funded key; also the template's one user member
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

    function deployRoles(bytes32 salt) internal view returns (address roles, bytes memory batch) {
        roles = predict(custody, salt);
        batch = abi.encodePacked(
            entry(1, CREATE_CALL, abi.encodeCall(ICreateCall.performCreate2, (0, proxyCode(), salt))),
            entry(0, roles, abi.encodeCall(IRoles.setUp, (abi.encode(custody, custody, custody)))),
            entry(0, custody, abi.encodeCall(ISafe.enableModule, (roles)))
        );
    }

    function params() internal view returns (LeverageYieldParams memory) {
        address[] memory users = new address[](1);
        users[0] = deployer;
        return LeverageYieldParams({
            avatar: custody,
            gate: gate,
            collateral: GOLD_TOKEN,
            pool: POOL,
            borrowAsset: USDC,
            yieldVault: address(vault),
            borrowCap: uint128(CAP),
            users: users,
            agents: new address[](0),
            agentWithdraw: false
        });
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
        batch = abi.encodePacked(batch, T.install(params()));
        execSafe(custody, MULTISEND, abi.encodeCall(IMultiSend.multiSend, (batch)), 1);

        // mint the gold stand-in to custody, and the vault's standing yield
        IFaucet(FAUCET).mint(GOLD_TOKEN, custody, 1e18);
        IFaucet(FAUCET).mint(USDC, address(vault), 100e6);

        // OPEN: supply gold + borrow stable + deposit yield, one atomic MultiSend through the gate
        (bool ok,) = gate.call(T.execCall(T.OPEN_ROLE, T.openBatch(params(), GOLD_AMT, BORROW)));
        require(ok, "open");

        // CLOSE: redeem all shares + repay-max + withdraw-max
        uint256 shares = IERC20(address(vault)).balanceOf(custody);
        (ok,) = gate.call(T.execCall(T.OPEN_ROLE, T.closeBatch(params(), shares, true)));
        require(ok, "close");

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
