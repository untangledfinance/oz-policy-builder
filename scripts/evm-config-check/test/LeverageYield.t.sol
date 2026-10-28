// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Prime on EVM, the leverage-yield execution adapter, configuration only. It
// adds no contract of Prime's: the leverage-yield policy template is a set of
// Zodiac Roles v2.1.1 scopes on the same custody gate the custody-yield
// reference line uses (docs/evm.md, test/ConfigOnly.t.sol and test/RefLine.t.sol).
// Every contract this test deploys is an unmodified deployment of existing
// code: Safe proxies of the canonical Safe singletons and ERC-1167 proxies of
// the canonical Zodiac Roles v2.1.1 mastercopy. Venues and tokens are the live
// Aave v3 Base Sepolia ones. The one exception is MockVault below, a minimal
// ERC-4626-shaped yield source deployed as a TEST FIXTURE only (like the
// reference line's mock router): Base Sepolia has no liquid 4626 vault that
// lists the borrow stablecoin, so the fixture stands in for one. It is never
// deployed on a network and is not a Prime production contract.
//
// The flow (Mr. Quan, 28 October 2026): a user holds tokenised gold in the
// custody Safe, borrows a stablecoin on Aave against it, and deploys the
// borrowed stablecoin into a yield source that pays more than the borrow cost,
// in one atomic batch. The gold stand-in on Base Sepolia is cbETH, an Aave v3
// reserve the market lists as collateral (LTV 82.5%), supplied and withdrawn
// only, the same role gold plays. The borrow stablecoin is the market's test
// USDC. Run with FORK_URL set to a Base Sepolia RPC.

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
    function isModuleEnabled(address) external view returns (bool);
    function execTransactionFromModule(address, uint256, bytes calldata, uint8) external returns (bool);
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
    function repay(address, uint256, uint256, address) external returns (uint256);
    function getUserAccountData(address)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256);
}

interface IVault {
    function deposit(uint256, address) external returns (uint256);
    function redeem(uint256, address, address) external returns (uint256);
}

/// A minimal ERC-4626-shaped yield source, TEST FIXTURE only. Shares are 1:1
/// with the asset; a one-off yield top-up lets a close return more than the
/// deposit, so the carry nets a spread. It is never deployed on a network.
contract MockVault {
    address public immutable asset;
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;

    constructor(address a) {
        asset = a;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        require(IERC20(asset).transferFrom(msg.sender, address(this), assets), "pull");
        shares = assets;
        balanceOf[receiver] += shares;
        totalSupply += shares;
    }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        require(balanceOf[owner] >= shares, "shares");
        balanceOf[owner] -= shares;
        totalSupply -= shares;
        // 1:1 plus a pro-rata share of any yield top-up held above totalSupply
        uint256 bal = IERC20(asset).balanceOf(address(this));
        assets = totalSupply == 0 && shares > 0 ? bal : shares;
        if (assets > bal) assets = bal;
        require(IERC20(asset).transfer(receiver, assets), "pay");
    }
}

contract LeverageYieldTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    // Base Sepolia (84532), canonical existing contracts
    address constant SAFE_141 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762; // SafeL2 1.4.1
    address constant FACTORY_141 = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant SAFE_150 = 0xEdd160fEBBD92E350D4D398fb636302fccd67C7e; // SafeL2 1.5.0
    address constant FACTORY_150 = 0x14F2982D601c9458F93bd70B218933A6f8165e7b;
    address constant MULTISEND = 0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526; // 1.4.1
    address constant MULTISEND_CALL_ONLY = 0x9641d764fc13c8B624c04430C7356C1C7C8102e2; // 1.4.1
    address constant CREATE_CALL = 0x9b35Af71d77eaf8d7e40252370304687390A1A52; // 1.4.1
    address constant ROLES = 0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5; // Zodiac Roles v2.1.1 mastercopy
    address constant UNWRAPPER = 0x93B7fCbc63ED8a3a24B59e1C3e6649D50B7427c0; // Roles MultiSend unwrapper

    // Aave v3 test market on Base Sepolia
    address constant POOL = 0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27;
    // gold stand-in: a collateral reserve the market lists. First choice was WBTC (borrowing disabled, the most
    // gold-like store of value), but the test market's WBTC supply cap is full (175 of 175). cbETH is the
    // practical stand-in: an Aave v3 collateral (LTV 82.5%), no supply cap, faucet-mintable. The template never
    // scopes a borrow of it, so the collateral is only ever supplied and withdrawn, as gold would be.
    address constant GOLD_TOKEN = 0xD171b9694f7A2597Ed006D41f7509aaD4B485c4B; // cbETH (18 decimals)
    address constant USDC = 0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f; // borrow stablecoin (6 decimals)
    address constant FAUCET_OWNER = 0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc; // the tokens' owner, mints test tokens

    // ParameterType
    uint8 constant NONE = 0;
    uint8 constant STATIC = 1;
    uint8 constant CALLDATA = 5;
    // Operator
    uint8 constant PASS = 0;
    uint8 constant OR = 2;
    uint8 constant MATCHES = 5;
    uint8 constant EQUAL_TO_AVATAR = 15;
    uint8 constant EQUAL_TO = 16;
    uint8 constant LESS_THAN = 18;
    uint8 constant WITHIN_ALLOWANCE = 28;
    // Roles Status codes inside ConditionViolation(uint8,bytes32)
    uint8 constant S_DELEGATECALL = 1;
    uint8 constant S_TARGET = 2;
    uint8 constant S_FUNCTION = 3;
    uint8 constant S_PARAM = 7;
    uint8 constant S_OR = 5;
    uint8 constant S_ALLOWANCE = 17;

    bytes32 constant LEVERAGE = "leverage-yield"; // custody's role for the leverage-yield adapter
    bytes32 constant BORROW_CAP = "leverage-borrow"; // the borrow budget, the LTV-at-signing control

    uint256 constant VARIABLE = 2; // Aave v3 variable interest rate mode
    uint256 constant GOLD_AMT = 5e17; // 0.5 cbETH (18 decimals), the collateral supplied (about $1,338)
    uint256 constant BORROW = 500e6; // the stablecoin the user signs to borrow (about 37% LTV)
    uint256 constant CAP = 2_000e6; // the Roles borrow cap = the signed LTV ceiling

    uint256[3] custodyKeys = [uint256(0xC1), 0xC2, 0xC3];
    uint256[3] primeKeys = [uint256(0xB1), 0xB2, 0xB3];
    uint256 constant AGENT_KEY = 0xA1;
    address agent;
    address stranger = address(0x5757);

    address custody; // the custody Safe: holds the gold, the debt and the yield shares
    address gate; // the custody gate: a Roles modifier on the custody Safe
    address prime; // the Prime account: a Safe, 2 of 3, holds nothing
    MockVault vault; // the yield source fixture

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

    function execSafe(address safe, address to, bytes memory data, uint8 op, uint256[] memory keys)
        internal
        returns (bool)
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

    function status(bytes memory err) internal pure returns (uint8 s) {
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

    function one(bytes32 k) internal pure returns (bytes32[] memory l) {
        l = new bytes32[](1);
        l[0] = k;
    }

    function one(address a) internal pure returns (address[] memory l) {
        l = new address[](1);
        l[0] = a;
    }

    function yes() internal pure returns (bool[] memory l) {
        l = new bool[](1);
        l[0] = true;
    }

    // --------------------------------------------- the leverage-yield template

    /// The leverage-yield policy template: the Roles scopes that let the custody
    /// gate run exactly the open and close of Mr. Quan's flow and nothing else.
    /// Written to the gate by custody (3 of 3). Mirrors how ConfigOnly writes
    /// the custody-yield trading role; it adds no contract.
    function leverageConfig() internal view returns (bytes memory) {
        // approve(spender, amount) on the gold (cbETH): spender is pinned to the Aave pool; the amount is open,
        // so a repay or deposit can use an infinite approve. The spender pin is the control: an approval can
        // never reach a stranger, and the funds themselves are bounded by the supply, borrow and deposit scopes.
        ConditionFlat[] memory goldApprove = new ConditionFlat[](3);
        goldApprove[0] = c(0, CALLDATA, MATCHES, "");
        goldApprove[1] = c(0, STATIC, EQUAL_TO, abi.encode(POOL));
        goldApprove[2] = c(0, STATIC, PASS, "");

        // approve(spender, amount) on the stablecoin (USDC): spender is the pool OR the yield vault, amount open
        ConditionFlat[] memory stableApprove = new ConditionFlat[](5);
        stableApprove[0] = c(0, CALLDATA, MATCHES, "");
        stableApprove[1] = c(0, NONE, OR, ""); // spender: one of the two pinned venues
        stableApprove[2] = c(0, STATIC, PASS, "");
        stableApprove[3] = c(1, STATIC, EQUAL_TO, abi.encode(POOL));
        stableApprove[4] = c(1, STATIC, EQUAL_TO, abi.encode(address(vault)));

        // supply(asset, amount, onBehalfOf, referral): the gold, on behalf of custody
        ConditionFlat[] memory supply = new ConditionFlat[](5);
        supply[0] = c(0, CALLDATA, MATCHES, "");
        supply[1] = c(0, STATIC, EQUAL_TO, abi.encode(GOLD_TOKEN));
        supply[2] = c(0, STATIC, PASS, ""); // amount: custody's own gold
        supply[3] = c(0, STATIC, EQUAL_TO_AVATAR, ""); // onBehalfOf = custody
        supply[4] = c(0, STATIC, PASS, ""); // referral

        // borrow(asset, amount, rateMode, referral, onBehalfOf): the stablecoin, capped, variable, to custody
        ConditionFlat[] memory borrow = new ConditionFlat[](6);
        borrow[0] = c(0, CALLDATA, MATCHES, "");
        borrow[1] = c(0, STATIC, EQUAL_TO, abi.encode(USDC));
        borrow[2] = c(0, STATIC, WITHIN_ALLOWANCE, abi.encode(BORROW_CAP)); // the LTV-at-signing bound
        borrow[3] = c(0, STATIC, EQUAL_TO, abi.encode(VARIABLE));
        borrow[4] = c(0, STATIC, PASS, ""); // referral
        borrow[5] = c(0, STATIC, EQUAL_TO_AVATAR, ""); // onBehalfOf = custody

        // deposit(assets, receiver) on the yield vault: receiver is custody
        ConditionFlat[] memory deposit = new ConditionFlat[](3);
        deposit[0] = c(0, CALLDATA, MATCHES, "");
        deposit[1] = c(0, STATIC, PASS, ""); // assets
        deposit[2] = c(0, STATIC, EQUAL_TO_AVATAR, ""); // receiver = custody

        // redeem(shares, receiver, owner) on the yield vault: receiver and owner are custody
        ConditionFlat[] memory redeem = new ConditionFlat[](4);
        redeem[0] = c(0, CALLDATA, MATCHES, "");
        redeem[1] = c(0, STATIC, PASS, ""); // shares
        redeem[2] = c(0, STATIC, EQUAL_TO_AVATAR, ""); // receiver = custody
        redeem[3] = c(0, STATIC, EQUAL_TO_AVATAR, ""); // owner = custody

        // repay(asset, amount, rateMode, onBehalfOf): the stablecoin, max allowed, variable, for custody
        ConditionFlat[] memory repay = new ConditionFlat[](5);
        repay[0] = c(0, CALLDATA, MATCHES, "");
        repay[1] = c(0, STATIC, EQUAL_TO, abi.encode(USDC));
        repay[2] = c(0, STATIC, PASS, ""); // amount: type(uint256).max repays the whole debt
        repay[3] = c(0, STATIC, EQUAL_TO, abi.encode(VARIABLE));
        repay[4] = c(0, STATIC, EQUAL_TO_AVATAR, ""); // onBehalfOf = custody

        // withdraw(asset, amount, to): the gold, max allowed, to custody
        ConditionFlat[] memory withdraw = new ConditionFlat[](4);
        withdraw[0] = c(0, CALLDATA, MATCHES, "");
        withdraw[1] = c(0, STATIC, EQUAL_TO, abi.encode(GOLD_TOKEN));
        withdraw[2] = c(0, STATIC, PASS, ""); // amount: type(uint256).max withdraws all the gold
        withdraw[3] = c(0, STATIC, EQUAL_TO_AVATAR, ""); // to = custody

        bytes memory tokens = abi.encodePacked(
            // the Roles MultiSend unwrapper, so one batch is split and each inner call checked
            entry(
                0, gate, abi.encodeCall(IRoles.setTransactionUnwrapper, (MULTISEND_CALL_ONLY, IMultiSend.multiSend.selector, UNWRAPPER))
            ),
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
            // the borrow cap = the signed LTV ceiling, and the role members: the Prime account and its agent
            entry(0, gate, abi.encodeCall(IRoles.setAllowance, (BORROW_CAP, uint128(CAP), uint128(CAP), uint128(CAP), 1 days, 0))),
            entry(0, gate, abi.encodeCall(IRoles.assignRoles, (prime, one(LEVERAGE), yes()))),
            entry(0, gate, abi.encodeCall(IRoles.assignRoles, (agent, one(LEVERAGE), yes())))
        );
        return abi.encodePacked(tokens, poolScopes, vaultScopes);
    }

    // ---------------------------------------------------------------- the setup

    function build(address singleton, address factory) internal {
        // T1: the custody Safe (3 of 3) and the Prime account (2 of 3).
        custody = createSafe(singleton, factory, owners(custodyKeys), 3, 11);
        prime = createSafe(singleton, factory, owners(primeKeys), 2, 12);
        vault = new MockVault(USDC);

        // T3: custody deploys its gate and writes the leverage-yield template, signed by all three signers.
        bytes memory batch;
        (gate, batch) = deployRoles(custody, "leverage-gate");
        batch = abi.encodePacked(batch, leverageConfig());
        check(
            execSafe(custody, MULTISEND, abi.encodeCall(IMultiSend.multiSend, (batch)), 1, all(custodyKeys)),
            "custody writes the leverage-yield template"
        );

        // Fund custody with the gold stand-in, and the yield vault with a small carry top-up.
        vm.prank(FAUCET_OWNER);
        IERC20(GOLD_TOKEN).mint(custody, 1e18); // 1 cbETH
        vm.prank(FAUCET_OWNER);
        IERC20(USDC).mint(address(vault), 100e6); // the vault's standing yield, so a close nets a spread
    }

    // batch the inner venue calls into one MultiSend the gate unwraps and checks
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

    /// Run a MultiSend batch through the gate's leverage-yield role, as the given member.
    function viaGate(address member, bytes memory batchEntries) internal returns (bool ok, bytes memory err) {
        vm.prank(member);
        (ok, err) = gate.call(
            abi.encodeCall(
                IRoles.execTransactionWithRole,
                (MULTISEND_CALL_ONLY, 0, abi.encodeCall(IMultiSend.multiSend, (batchEntries)), 1, LEVERAGE, true)
            )
        );
    }

    /// Run a single inner call through the gate (for the refusal cases), as the given member.
    function oneCall(address member, address to, bytes memory data, uint8 op)
        internal
        returns (bool ok, bytes memory err)
    {
        vm.prank(member);
        (ok, err) = gate.call(abi.encodeCall(IRoles.execTransactionWithRole, (to, 0, data, op, LEVERAGE, true)));
    }

    // ---------------------------------------------------------------- the run

    function run_(address singleton, address factory) internal {
        build(singleton, factory);

        check(
            IRoles(gate).owner() == custody && IRoles(gate).avatar() == custody && IRoles(gate).target() == custody,
            "gate wired to custody"
        );
        check(ISafe(custody).isModuleEnabled(gate), "gate enabled on custody");
        string memory ver = ISafe(custody).VERSION();
        ver;

        // === 1. OPEN atomically: supply gold + borrow stable + deposit yield, one tx, all-or-nothing ===
        uint256 gold0 = IERC20(GOLD_TOKEN).balanceOf(custody);
        (bool ok, bytes memory err) = viaGate(prime, openBatch());
        check(ok, "OPEN batch runs atomically through Roles MultiSend");
        check(IERC20(GOLD_TOKEN).balanceOf(custody) == gold0 - GOLD_AMT, "custody supplied the gold");
        check(vault.balanceOf(custody) == BORROW, "custody holds the yield shares");
        check(IERC20(USDC).balanceOf(custody) == 0, "the borrowed stablecoin went into the vault, none idle");
        check(IERC20(USDC).balanceOf(prime) == 0 && IERC20(GOLD_TOKEN).balanceOf(prime) == 0, "Prime account holds nothing");
        (, uint256 debt,,,, uint256 hf) = IPool(POOL).getUserAccountData(custody);
        check(debt > 0, "custody carries the Aave debt");
        check(hf > 1e18, "the position is healthy after the open");

        // === 2. The borrow cap bounds the LTV: a second borrow over the cap is refused ===
        (ok, err) = oneCall(prime, POOL, abi.encodeCall(IPool.borrow, (USDC, CAP, VARIABLE, 0, custody)), 0);
        refusedWith(ok, err, S_ALLOWANCE, "a borrow over the signed cap is refused");

        // === 3. Aave's own health factor still applies, within the cap ===
        // Within the Roles cap but far beyond what the collateral supports: Aave reverts (collateral check).
        (ok, err) = oneCall(prime, POOL, abi.encodeCall(IPool.borrow, (USDC, 1_500e6, VARIABLE, 0, custody)), 0);
        check(!ok, "Aave refuses a borrow the collateral cannot support, even within the Roles cap");

        // === 4. CLOSE atomically: redeem all shares, repay-max, withdraw-max ===
        uint256 shares = vault.balanceOf(custody);
        (ok, err) = viaGate(agent, closeBatch(shares)); // the monitoring agent can close when the spread turns
        check(ok, "CLOSE batch runs atomically: redeem, repay-max, withdraw-max");
        (, uint256 debtAfter,,,,) = IPool(POOL).getUserAccountData(custody);
        check(debtAfter == 0, "the debt is fully repaid");
        uint256 goldBack = IERC20(GOLD_TOKEN).balanceOf(custody);
        check(goldBack + 10 >= gold0 && goldBack <= gold0 + 1e15, "all the gold is back in custody, within dust");
        check(vault.balanceOf(custody) == 0, "no yield shares left");
        check(IERC20(USDC).balanceOf(custody) > 0, "custody keeps the carry spread");

        // === 5. Gating: every out-of-scope call is refused with its Roles status ===
        refusals();
    }

    function refusals() internal {
        bytes memory sup = abi.encodeCall(IPool.supply, (GOLD_TOKEN, GOLD_AMT, custody, 0));
        bool ok;
        bytes memory err;

        // wrong target: a token or contract the template never scopes
        (ok, err) = oneCall(prime, address(0xBEEF), abi.encodeCall(IERC20.transfer, (stranger, 1)), 0);
        refusedWith(ok, err, S_TARGET, "a call to an unscoped target");

        // a plain transfer of the gold out of custody: approve is scoped on the gold, transfer is not
        (ok, err) = oneCall(prime, GOLD_TOKEN, abi.encodeCall(IERC20.transfer, (stranger, 1)), 0);
        refusedWith(ok, err, S_FUNCTION, "a plain transfer of the gold");

        // approve to a stranger (not the pool or the vault)
        (ok, err) = oneCall(prime, USDC, abi.encodeCall(IERC20.approve, (stranger, 1)), 0);
        refusedWith(ok, err, S_OR, "an approval to a stranger");
        (ok, err) = oneCall(prime, GOLD_TOKEN, abi.encodeCall(IERC20.approve, (stranger, 1)), 0);
        refusedWith(ok, err, S_PARAM, "a gold approval to a stranger");

        // supply on behalf of a stranger
        (ok, err) = oneCall(prime, POOL, abi.encodeCall(IPool.supply, (GOLD_TOKEN, GOLD_AMT, stranger, 0)), 0);
        refusedWith(ok, err, S_PARAM, "supply on behalf of a stranger");

        // borrow for someone else
        (ok, err) = oneCall(prime, POOL, abi.encodeCall(IPool.borrow, (USDC, 1e6, VARIABLE, 0, stranger)), 0);
        refusedWith(ok, err, S_PARAM, "borrow on behalf of a stranger");

        // borrow a different asset than the signed stablecoin
        (ok, err) = oneCall(prime, POOL, abi.encodeCall(IPool.borrow, (GOLD_TOKEN, 1, VARIABLE, 0, custody)), 0);
        refusedWith(ok, err, S_PARAM, "borrow an asset the template does not list");

        // deposit the yield to a stranger
        (ok, err) = oneCall(prime, address(vault), abi.encodeCall(IVault.deposit, (1e6, stranger)), 0);
        refusedWith(ok, err, S_PARAM, "deposit the yield for a stranger");

        // redeem the yield to a stranger
        (ok, err) = oneCall(prime, address(vault), abi.encodeCall(IVault.redeem, (1, stranger, custody)), 0);
        refusedWith(ok, err, S_PARAM, "redeem the yield to a stranger");

        // withdraw the gold to a stranger
        (ok, err) = oneCall(prime, POOL, abi.encodeCall(IPool.withdraw, (GOLD_TOKEN, 1, stranger)), 0);
        refusedWith(ok, err, S_PARAM, "withdraw the gold to a stranger");

        // a delegatecall to a venue (delegatecall is off; only the MultiSend unwrapper path is allowed)
        (ok, err) = oneCall(prime, POOL, sup, 1);
        refusedWith(ok, err, S_DELEGATECALL, "a delegatecall to the pool");

        // a call to the custody Safe's own settings, and to the gate itself
        (ok, err) = oneCall(prime, custody, abi.encodeCall(ISafe.enableModule, (stranger)), 0);
        refusedWith(ok, err, S_TARGET, "a call to the custody Safe itself");
        (ok, err) = oneCall(prime, gate, abi.encodeCall(IRoles.assignRoles, (stranger, one(LEVERAGE), yes())), 0);
        refusedWith(ok, err, S_TARGET, "a call to the gate itself");

        // a non-member cannot act
        vm.prank(stranger);
        (ok,) = gate.call(abi.encodeCall(IRoles.execTransactionWithRole, (POOL, 0, sup, 0, LEVERAGE, true)));
        check(!ok, "a stranger is not a member of the leverage-yield role");
    }

    // ---------------------------------------------------------------- entrypoints

    function test_leverage_safe141() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        run_(SAFE_141, FACTORY_141);
        emit log_named_uint("checks", passed);
        require(passed > 25, "count");
    }

    function test_leverage_safe150() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        run_(SAFE_150, FACTORY_150);
        emit log_named_uint("checks", passed);
        require(passed > 25, "count");
    }

    event log_count(uint256);
    event log_named_uint(string, uint256);
}
