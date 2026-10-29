// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    ConditionFlat,
    IRoles,
    IMultiSend,
    IERC20,
    IPool,
    IVault,
    LeverageYieldParams,
    LeverageYieldTemplate as T
} from "./LeverageYieldTemplate.sol";

// Prime on EVM, the leverage-yield policy template, configuration only. The
// scopes are not written here: they come from LeverageYieldTemplate.sol, the
// one source of truth the live and install scripts also use. This test runs
// the template on a Base Sepolia fork for two market configurations, each
// under Safe 1.4.1 and 1.5.0:
//
// - A: collateral cbETH, borrow USDC, agents de-risk only (no withdraw);
// - B: collateral WETH, borrow USDT, agents may also withdraw to custody.
//
// cbETH and WETH stand in for tokenised gold (Base Sepolia lists no gold);
// both are Aave v3 collateral, supplied and withdrawn only. Every contract the
// test deploys is an unmodified deployment of existing code (Safe proxies of
// the canonical singletons, ERC-1167 proxies of the Zodiac Roles v2.1.1
// mastercopy), except MockVault below: a minimal ERC-4626-shaped yield source,
// a TEST FIXTURE only, since Base Sepolia lists no liquid 4626 vault for the
// borrow stablecoins. Run with FORK_URL set to a Base Sepolia RPC; without it
// only the offline validation test runs.

interface Vm {
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function addr(uint256) external returns (address);
    function createSelectFork(string calldata) external returns (uint256);
    function envOr(string calldata, string calldata) external returns (string memory);
    function prank(address) external;
    function warp(uint256) external;
    function skip(bool) external;
    function deal(address, uint256) external;
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
}

interface IProxyFactory {
    function createProxyWithNonce(address, bytes memory, uint256) external returns (address);
}

interface ICreateCall {
    function performCreate2(uint256, bytes memory, bytes32) external returns (address);
}

interface ITestToken {
    function mint(address, uint256) external returns (bool);
}

interface IWETH {
    function deposit() external payable;
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
        // 1:1, and the last redeemer takes the yield top-up held above totalSupply
        uint256 bal = IERC20(asset).balanceOf(address(this));
        assets = totalSupply == 0 && shares > 0 ? bal : shares;
        if (assets > bal) assets = bal;
        require(IERC20(asset).transfer(receiver, assets), "pay");
    }
}

/// Lets the offline test catch a library revert.
contract TemplateProbe {
    function validate(LeverageYieldParams memory p) external pure {
        T.validate(p);
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
    address constant CREATE_CALL = 0x9b35Af71d77eaf8d7e40252370304687390A1A52; // 1.4.1
    address constant ROLES = 0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5; // Zodiac Roles v2.1.1 mastercopy

    // Aave v3 test market on Base Sepolia, and its test tokens (minted by the faucet, their owner)
    address constant POOL = 0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27;
    address constant CBETH = 0xD171b9694f7A2597Ed006D41f7509aaD4B485c4B; // 18 decimals, LTV 82.5%
    address constant LINK = 0x810D46F9a9027E28F9B01F75E2bdde839dA61115; // a listed asset the template never lists
    address constant USDC = 0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f; // 6 decimals
    address constant USDT = 0x0a215D8ba66387DCA84B284D18c3B4ec3de6E54a; // 6 decimals
    address constant WETH = 0x4200000000000000000000000000000000000006; // 18 decimals, LTV 83.5%
    address constant FAUCET_OWNER = 0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc;

    // Roles Status codes inside ConditionViolation(uint8,bytes32)
    uint8 constant S_DELEGATECALL = 1;
    uint8 constant S_TARGET = 2;
    uint8 constant S_FUNCTION = 3;
    uint8 constant S_SEND = 4;
    uint8 constant S_OR = 5;
    uint8 constant S_PARAM = 7;
    uint8 constant S_ALLOWANCE = 17;
    bytes4 constant CONDITION_VIOLATION = bytes4(keccak256("ConditionViolation(uint8,bytes32)"));
    bytes4 constant NOT_AUTHORIZED = bytes4(keccak256("NotAuthorized(address)"));
    bytes4 constant NO_MEMBERSHIP = bytes4(keccak256("NoMembership()"));
    bytes4 constant NOT_OWNER = bytes4(keccak256("OwnableUnauthorizedAccount(address)"));

    struct Cfg {
        address collateral;
        address borrowAsset;
        uint256 collateralAmount; // supplied by the open
        uint256 borrowAmount; // the borrow the user signs
        uint128 cap; // the borrow budget = the LTV signed at setup
        bool agentWithdraw;
    }

    uint256[3] custodyKeys = [uint256(0xC1), 0xC2, 0xC3];
    uint256[3] primeKeys = [uint256(0xB1), 0xB2, 0xB3];
    uint256 constant AGENT_KEY = 0xA1;
    address agent;
    address stranger = address(0x5757);

    address custody; // the custody Safe: holds the collateral, the debt and the yield shares
    address gate; // the custody gate: a Roles modifier on the custody Safe
    address prime; // the Prime account: a Safe, 2 of 3, holds nothing
    MockVault vault; // the yield source fixture
    LeverageYieldParams p; // the template's parameters for this run
    Cfg cfg;

    uint256 passed;
    bool forked;

    function setUp() public {
        agent = vm.addr(AGENT_KEY);
        string memory url = vm.envOr("FORK_URL", "");
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;
    }

    function configA() internal pure returns (Cfg memory) {
        // 0.5 cbETH (about $1,330), borrow 500 USDC (about 38% LTV), cap 600 USDC (about 45%)
        return Cfg(CBETH, USDC, 5e17, 500e6, 600e6, false);
    }

    function configB() internal pure returns (Cfg memory) {
        // 0.5 WETH (about $1,160), borrow 500 USDT (about 43% LTV), cap 700 USDT (about 60%)
        // (LINK was the first choice, but the test market's LINK supply cap is all but full)
        return Cfg(WETH, USDT, 5e17, 500e6, 700e6, true);
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

    /// custody signs (all three signers) a call or a MultiSend
    function execCustody(address to, bytes memory data, uint8 op) internal returns (bool) {
        bytes32 h =
            ISafe(custody).getTransactionHash(to, 0, data, op, 0, 0, 0, address(0), address(0), ISafe(custody).nonce());
        uint256[] memory keys = new uint256[](3);
        for (uint256 i; i < 3; i++) {
            keys[i] = custodyKeys[i];
        }
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
        return ISafe(custody).execTransaction(to, 0, data, op, 0, 0, 0, address(0), address(0), sigs);
    }

    function proxyCode() internal pure returns (bytes memory) {
        return
            abi.encodePacked(hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", ROLES, hex"5af43d82803e903d91602b57fd5bf3");
    }

    /// custody's gate: an ERC-1167 proxy of the Roles mastercopy, made through CreateCall, set up and
    /// enabled in the same custody transaction that installs the template
    function deployRoles(bytes32 salt) internal view returns (address roles, bytes memory batch) {
        roles =
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), custody, salt, keccak256(proxyCode()))))));
        bytes memory create = abi.encodeCall(ICreateCall.performCreate2, (0, proxyCode(), salt));
        batch = abi.encodePacked(
            abi.encodePacked(uint8(1), CREATE_CALL, uint256(0), create.length, create), // delegatecall, by custody
            T.entry(roles, abi.encodeCall(IRoles.setUp, (abi.encode(custody, custody, custody)))),
            T.entry(custody, abi.encodeCall(ISafe.enableModule, (roles)))
        );
    }

    function status(bytes memory err) internal pure returns (uint8 s) {
        require(err.length == 68, "not a ConditionViolation");
        require(bytes4(err) == CONDITION_VIOLATION, "other error");
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

    function refusedSel(bool ok, bytes memory err, bytes4 want, string memory what) internal {
        require(!ok, what);
        require(err.length >= 4 && bytes4(err) == want, what);
        passed++;
    }

    /// a MultiSend batch through the gate, as `member` under `role`
    function viaGate(address member, bytes32 role, bytes memory batch) internal returns (bool ok, bytes memory err) {
        vm.prank(member);
        (ok, err) = gate.call(T.execCall(role, batch));
    }

    /// a single inner call through the gate, as `member` under `role`
    function oneCall(address member, bytes32 role, address to, bytes memory data, uint8 op)
        internal
        returns (bool ok, bytes memory err)
    {
        vm.prank(member);
        (ok, err) = gate.call(abi.encodeCall(IRoles.execTransactionWithRole, (to, 0, data, op, role, true)));
    }

    function debtOf() internal view returns (uint256 debt, uint256 hf) {
        (, debt,,,, hf) = IPool(POOL).getUserAccountData(custody);
    }

    function mint(address token, address to, uint256 amount) internal {
        if (token == WETH) {
            vm.deal(address(this), amount);
            IWETH(WETH).deposit{value: amount}();
            require(IERC20(WETH).transfer(to, amount), "weth");
            return;
        }
        vm.prank(FAUCET_OWNER);
        ITestToken(token).mint(to, amount);
    }

    // ---------------------------------------------------------------- the setup

    function build(address singleton, address factory, Cfg memory k) internal {
        cfg = k;
        custody = createSafe(singleton, factory, owners(custodyKeys), 3, 11);
        prime = createSafe(singleton, factory, owners(primeKeys), 2, 12);
        vault = new MockVault(k.borrowAsset);

        bytes memory batch;
        (gate, batch) = deployRoles("leverage-gate");

        address[] memory users = new address[](1);
        users[0] = prime;
        address[] memory agents = new address[](1);
        agents[0] = agent;
        p = LeverageYieldParams({
            avatar: custody,
            gate: gate,
            collateral: k.collateral,
            pool: POOL,
            borrowAsset: k.borrowAsset,
            yieldVault: address(vault),
            borrowCap: k.cap,
            users: users,
            agents: agents,
            agentWithdraw: k.agentWithdraw
        });

        // custody deploys its gate and installs the template, one transaction signed by all three signers
        batch = abi.encodePacked(batch, T.install(p));
        check(
            execCustody(MULTISEND, abi.encodeCall(IMultiSend.multiSend, (batch)), 1),
            "custody installs the template in one transaction"
        );
        T.verify(p); // the gate is wired to and owned by custody, the vault takes the borrow asset
        check(ISafe(custody).isModuleEnabled(gate), "gate enabled on custody");

        mint(k.collateral, custody, 2 * k.collateralAmount);
        mint(k.borrowAsset, address(vault), 100e6); // the vault's standing yield, so a close nets a spread
    }

    // ---------------------------------------------------------------- the run

    function run_(address singleton, address factory, Cfg memory k) internal {
        build(singleton, factory, k);
        uint256 coll0 = IERC20(k.collateral).balanceOf(custody);

        // === 1. a batch with one bad leg is refused whole: nothing moves ===
        bytes memory bad = abi.encodePacked(
            T.entry(k.collateral, abi.encodeCall(IERC20.approve, (POOL, k.collateralAmount))),
            T.entry(POOL, abi.encodeCall(IPool.supply, (k.collateral, k.collateralAmount, custody, 0))),
            T.entry(POOL, abi.encodeCall(IPool.borrow, (k.borrowAsset, k.borrowAmount, T.VARIABLE, 0, custody))),
            T.entry(k.borrowAsset, abi.encodeCall(IERC20.approve, (address(vault), k.borrowAmount))),
            T.entry(address(vault), abi.encodeCall(IVault.deposit, (k.borrowAmount, stranger)))
        );
        (bool ok, bytes memory err) = viaGate(prime, T.OPEN_ROLE, bad);
        refusedWith(ok, err, S_PARAM, "an open batch whose last leg pays a stranger is refused whole");
        (uint256 debt, uint256 hf) = debtOf();
        check(IERC20(k.collateral).balanceOf(custody) == coll0 && debt == 0, "the refused batch moved nothing");

        // === 2. OPEN atomically, as the user (the Prime account) ===
        (ok, err) = viaGate(prime, T.OPEN_ROLE, T.openBatch(p, k.collateralAmount, k.borrowAmount));
        check(ok, "OPEN: approve, supply, borrow, approve, deposit in one batch");
        check(IERC20(k.collateral).balanceOf(custody) == coll0 - k.collateralAmount, "custody supplied the collateral");
        check(vault.balanceOf(custody) == k.borrowAmount, "custody holds the yield shares");
        check(IERC20(k.borrowAsset).balanceOf(custody) == 0, "no borrowed stablecoin left idle");
        check(
            IERC20(k.borrowAsset).balanceOf(prime) == 0 && IERC20(k.collateral).balanceOf(prime) == 0,
            "the Prime account holds nothing"
        );
        (debt, hf) = debtOf();
        check(debt > 0 && hf > 1e18, "custody carries a healthy Aave debt");

        // === 3. the borrow cap bounds the leverage, exactly, and does not refill ===
        uint256 left = k.cap - k.borrowAmount;
        bytes memory over = abi.encodeCall(IPool.borrow, (k.borrowAsset, left + 1, T.VARIABLE, 0, custody));
        (ok, err) = oneCall(prime, T.OPEN_ROLE, POOL, over, 0);
        refusedWith(ok, err, S_ALLOWANCE, "a borrow one unit over the cap is refused");
        (ok,) = oneCall(
            prime, T.OPEN_ROLE, POOL, abi.encodeCall(IPool.borrow, (k.borrowAsset, left, T.VARIABLE, 0, custody)), 0
        );
        check(ok, "a borrow up to the cap exactly runs");
        vm.warp(block.timestamp + 30 days);
        (ok, err) = oneCall(
            prime, T.OPEN_ROLE, POOL, abi.encodeCall(IPool.borrow, (k.borrowAsset, 1, T.VARIABLE, 0, custody)), 0
        );
        refusedWith(ok, err, S_ALLOWANCE, "the spent cap does not refill, 30 days on");

        // === 4. the agent cannot add risk or move funds out ===
        agentRefusals();

        // === 5. the agent de-risks: redeem half the shares, repay that much ===
        uint256 half = vault.balanceOf(custody) / 2;
        (uint256 debtBefore, uint256 hfBefore) = debtOf();
        (ok, err) = viaGate(agent, T.CLOSE_ROLE, T.deleverageBatch(p, half, half));
        check(ok, "the agent de-risks in one batch: redeem, approve, repay");
        (debt, hf) = debtOf();
        check(debt < debtBefore && hf > hfBefore, "the debt fell and the health factor rose");

        // === 6. CLOSE atomically ===
        uint256 shares = vault.balanceOf(custody);
        if (k.agentWithdraw) {
            (ok, err) = viaGate(agent, T.CLOSE_ROLE, T.closeBatch(p, shares, true));
            check(ok, "the agent closes in one batch: redeem, repay-max, withdraw-max");
        } else {
            (ok, err) = viaGate(agent, T.CLOSE_ROLE, T.closeBatch(p, shares, true));
            refusedWith(ok, err, S_FUNCTION, "the agent's close with a withdraw is refused whole (no withdraw)");
            (ok, err) = viaGate(agent, T.CLOSE_ROLE, T.closeBatch(p, shares, false));
            check(ok, "the agent clears the debt in one batch: redeem, repay-max");
            (debt,) = debtOf();
            check(debt == 0, "the debt is gone, the collateral stays supplied for custody");
            (ok, err) = viaGate(prime, T.OPEN_ROLE, T.withdrawEntry(p));
            check(ok, "the user withdraws the collateral to custody");
        }
        (debt,) = debtOf();
        check(debt == 0, "the debt is fully repaid");
        uint256 back = IERC20(k.collateral).balanceOf(custody);
        check(back + 10 >= coll0 && back <= coll0 + 1e16, "all the collateral is back in custody, within dust");
        check(vault.balanceOf(custody) == 0, "no yield shares left");
        check(IERC20(k.borrowAsset).balanceOf(custody) > 0, "custody keeps the carry spread");

        // === 7. the cap is a budget: a re-open needs custody to re-arm it ===
        (ok, err) = viaGate(prime, T.OPEN_ROLE, T.openBatch(p, k.collateralAmount, k.borrowAmount));
        refusedWith(ok, err, S_ALLOWANCE, "a re-open on a spent cap is refused whole");
        (ok, err) = oneCall(prime, T.OPEN_ROLE, gate, T.rearmCall(k.cap), 0);
        refusedWith(ok, err, S_TARGET, "the user cannot re-arm the cap through the gate");
        vm.prank(prime);
        (ok, err) = gate.call(T.rearmCall(type(uint128).max));
        refusedSel(ok, err, NOT_OWNER, "the user cannot write the cap on the gate directly");
        check(execCustody(gate, T.rearmCall(10 * k.cap), 0), "custody re-arms the cap");
        (ok, err) = viaGate(prime, T.OPEN_ROLE, T.openBatch(p, k.collateralAmount, k.borrowAmount));
        check(ok, "the re-armed open runs");

        // === 8. Aave's own max LTV is the backstop inside the cap ===
        bytes memory deep = abi.encodeCall(IPool.borrow, (k.borrowAsset, 9 * k.cap, T.VARIABLE, 0, custody));
        (ok, err) = oneCall(prime, T.OPEN_ROLE, POOL, deep, 0);
        check(!ok && bytes4(err) != CONDITION_VIOLATION, "Aave refuses a borrow the collateral cannot carry");

        // === 9. the user's refusals ===
        refusals();
    }

    function agentRefusals() internal {
        Cfg memory k = cfg;
        bool ok;
        bytes memory err;

        (ok, err) = viaGate(agent, T.OPEN_ROLE, T.openBatch(p, k.collateralAmount, 1));
        refusedSel(ok, err, NO_MEMBERSHIP, "the agent is not a member of the open role");
        (ok, err) = viaGate(agent, T.CLOSE_ROLE, T.openBatch(p, k.collateralAmount, 1));
        refusedWith(ok, err, S_TARGET, "an open batch under the close role is refused whole");
        bytes memory b = abi.encodeCall(IPool.borrow, (k.borrowAsset, 1, T.VARIABLE, 0, custody));
        (ok, err) = oneCall(agent, T.CLOSE_ROLE, POOL, b, 0);
        refusedWith(ok, err, S_FUNCTION, "the agent cannot borrow");
        (ok, err) = oneCall(agent, T.CLOSE_ROLE, POOL, abi.encodeCall(IPool.supply, (k.collateral, 1, custody, 0)), 0);
        refusedWith(ok, err, S_FUNCTION, "the agent cannot supply");
        (ok, err) = oneCall(agent, T.CLOSE_ROLE, address(vault), abi.encodeCall(IVault.deposit, (1, custody)), 0);
        refusedWith(ok, err, S_FUNCTION, "the agent cannot deposit");
        (ok, err) = oneCall(agent, T.CLOSE_ROLE, k.borrowAsset, abi.encodeCall(IERC20.approve, (address(vault), 1)), 0);
        refusedWith(ok, err, S_PARAM, "the agent cannot approve the vault");
        (ok, err) = oneCall(agent, T.CLOSE_ROLE, k.borrowAsset, abi.encodeCall(IERC20.transfer, (agent, 1)), 0);
        refusedWith(ok, err, S_FUNCTION, "the agent cannot transfer the stablecoin");
        (ok, err) = oneCall(agent, T.CLOSE_ROLE, k.collateral, abi.encodeCall(IERC20.transfer, (agent, 1)), 0);
        refusedWith(ok, err, S_TARGET, "the agent cannot touch the collateral token");
        (ok, err) = oneCall(agent, T.CLOSE_ROLE, address(vault), abi.encodeCall(IVault.redeem, (1, agent, custody)), 0);
        refusedWith(ok, err, S_PARAM, "the agent cannot redeem to itself");
        (ok, err) = oneCall(
            agent, T.CLOSE_ROLE, POOL, abi.encodeCall(IPool.repay, (k.borrowAsset, 1, T.VARIABLE, stranger)), 0
        );
        refusedWith(ok, err, S_PARAM, "the agent cannot repay a stranger's debt");
        bytes memory w = abi.encodeCall(IPool.withdraw, (k.collateral, 1, agent));
        (ok, err) = oneCall(agent, T.CLOSE_ROLE, POOL, w, 0);
        refusedWith(ok, err, k.agentWithdraw ? S_PARAM : S_FUNCTION, "the agent cannot withdraw to itself");
    }

    function refusals() internal {
        Cfg memory k = cfg;
        bytes memory sup = abi.encodeCall(IPool.supply, (k.collateral, 1, custody, 0));
        bool ok;
        bytes memory err;

        (ok, err) = oneCall(prime, T.OPEN_ROLE, address(0xBEEF), abi.encodeCall(IERC20.transfer, (stranger, 1)), 0);
        refusedWith(ok, err, S_TARGET, "a call to an unscoped target");
        (ok, err) = oneCall(prime, T.OPEN_ROLE, k.collateral, abi.encodeCall(IERC20.transfer, (stranger, 1)), 0);
        refusedWith(ok, err, S_FUNCTION, "a plain transfer of the collateral");
        (ok, err) =
            oneCall(prime, T.OPEN_ROLE, k.collateral, abi.encodeCall(IERC20.transferFrom, (custody, stranger, 1)), 0);
        refusedWith(ok, err, S_FUNCTION, "a transferFrom of the collateral");
        (ok, err) = oneCall(prime, T.OPEN_ROLE, k.borrowAsset, abi.encodeCall(IERC20.transfer, (stranger, 1)), 0);
        refusedWith(ok, err, S_FUNCTION, "a plain transfer of the stablecoin");
        (ok, err) = oneCall(prime, T.OPEN_ROLE, k.borrowAsset, abi.encodeCall(IERC20.approve, (stranger, 1)), 0);
        refusedWith(ok, err, S_OR, "a stablecoin approval to a stranger");
        (ok, err) = oneCall(prime, T.OPEN_ROLE, k.collateral, abi.encodeCall(IERC20.approve, (stranger, 1)), 0);
        refusedWith(ok, err, S_PARAM, "a collateral approval to a stranger");
        (ok, err) = oneCall(prime, T.OPEN_ROLE, POOL, abi.encodeCall(IPool.supply, (k.collateral, 1, stranger, 0)), 0);
        refusedWith(ok, err, S_PARAM, "supply on behalf of a stranger");
        (ok, err) = oneCall(
            prime, T.OPEN_ROLE, POOL, abi.encodeCall(IPool.borrow, (k.borrowAsset, 1, T.VARIABLE, 0, stranger)), 0
        );
        refusedWith(ok, err, S_PARAM, "borrow on behalf of a stranger");
        (ok, err) =
            oneCall(prime, T.OPEN_ROLE, POOL, abi.encodeCall(IPool.borrow, (k.borrowAsset, 1, 1, 0, custody)), 0);
        refusedWith(ok, err, S_PARAM, "borrow at a rate mode the template does not list");
        (ok, err) =
            oneCall(prime, T.OPEN_ROLE, POOL, abi.encodeCall(IPool.borrow, (LINK, 1, T.VARIABLE, 0, custody)), 0);
        refusedWith(ok, err, S_PARAM, "borrow an asset the template does not list");
        (ok, err) = oneCall(
            prime, T.OPEN_ROLE, POOL, abi.encodeCall(IPool.borrow, (k.collateral, 1, T.VARIABLE, 0, custody)), 0
        );
        refusedWith(ok, err, S_PARAM, "borrow the collateral token");
        (ok, err) = oneCall(prime, T.OPEN_ROLE, POOL, abi.encodeCall(IPool.supply, (LINK, 1, custody, 0)), 0);
        refusedWith(ok, err, S_PARAM, "supply an asset the template does not list");
        (ok, err) = oneCall(prime, T.OPEN_ROLE, address(vault), abi.encodeCall(IVault.deposit, (1, stranger)), 0);
        refusedWith(ok, err, S_PARAM, "deposit the yield for a stranger");
        (ok, err) =
            oneCall(prime, T.OPEN_ROLE, address(vault), abi.encodeCall(IVault.redeem, (1, stranger, custody)), 0);
        refusedWith(ok, err, S_PARAM, "redeem the yield to a stranger");
        (ok, err) = oneCall(prime, T.OPEN_ROLE, POOL, abi.encodeCall(IPool.withdraw, (k.collateral, 1, stranger)), 0);
        refusedWith(ok, err, S_PARAM, "withdraw the collateral to a stranger");
        (ok, err) = oneCall(prime, T.OPEN_ROLE, POOL, sup, 1);
        refusedWith(ok, err, S_DELEGATECALL, "a delegatecall to the pool");
        vm.prank(prime);
        (ok, err) = gate.call(abi.encodeCall(IRoles.execTransactionWithRole, (POOL, 1, sup, 0, T.OPEN_ROLE, true)));
        refusedWith(ok, err, S_SEND, "a call that sends value");
        (ok, err) = oneCall(prime, T.OPEN_ROLE, custody, abi.encodeCall(ISafe.enableModule, (stranger)), 0);
        refusedWith(ok, err, S_TARGET, "a call to the custody Safe itself");
        (ok, err) = oneCall(prime, T.OPEN_ROLE, gate, abi.encodeCall(IRoles.scopeTarget, (T.OPEN_ROLE, stranger)), 0);
        refusedWith(ok, err, S_TARGET, "a call to the gate itself");
        (ok, err) = viaGate(prime, T.CLOSE_ROLE, T.deleverageBatch(p, 0, 0));
        refusedSel(ok, err, NO_MEMBERSHIP, "the user is not a member of the agent's role");
        vm.prank(stranger);
        (ok, err) = gate.call(abi.encodeCall(IRoles.execTransactionWithRole, (POOL, 0, sup, 0, T.OPEN_ROLE, true)));
        refusedSel(ok, err, NOT_AUTHORIZED, "a stranger is not a member of the open role");
        vm.prank(stranger);
        (ok, err) = gate.call(T.execCall(T.CLOSE_ROLE, T.deleverageBatch(p, 0, 0)));
        refusedSel(ok, err, NOT_AUTHORIZED, "a stranger is not a member of the close role");
    }

    // ---------------------------------------------------------------- entrypoints

    function runOn(address singleton, address factory, Cfg memory k) internal {
        if (!forked) {
            vm.skip(true);
            return;
        }
        run_(singleton, factory, k);
        emit log_named_uint("checks", passed);
        require(passed >= (k.agentWithdraw ? 59 : 62), "count");
    }

    function test_template_A_safe141() public {
        runOn(SAFE_141, FACTORY_141, configA());
    }

    function test_template_A_safe150() public {
        runOn(SAFE_150, FACTORY_150, configA());
    }

    function test_template_B_safe141() public {
        runOn(SAFE_141, FACTORY_141, configB());
    }

    function test_template_B_safe150() public {
        runOn(SAFE_150, FACTORY_150, configB());
    }

    /// Offline: the builder refuses a parameter set it cannot install safely.
    function test_template_validation() public {
        TemplateProbe probe = new TemplateProbe();
        LeverageYieldParams memory good = sample();
        probe.validate(good);
        passed++;

        LeverageYieldParams memory q = sample();
        q.collateral = address(0);
        refusedParams(probe, q, "collateral is zero");
        q = sample();
        q.borrowAsset = q.collateral;
        refusedParams(probe, q, "collateral is the borrow asset");
        q = sample();
        q.borrowCap = 0;
        refusedParams(probe, q, "borrow cap is zero");
        q = sample();
        q.yieldVault = q.pool;
        refusedParams(probe, q, "two roles share one address");
        q = sample();
        q.users = new address[](0);
        refusedParams(probe, q, "no user member");
        q = sample();
        q.agents[0] = q.users[0];
        refusedParams(probe, q, "a member is both user and agent");
        q = sample();
        q.users[0] = q.avatar;
        refusedParams(probe, q, "member is the custody Safe or the gate");
        q = sample();
        q.agents[0] = q.pool;
        refusedParams(probe, q, "member is a venue or token");
        q = sample();
        q.agents = new address[](0);
        q.agentWithdraw = true;
        refusedParams(probe, q, "agentWithdraw without an agent");

        // the install is deterministic, and grows by the agent's role only when there is an agent
        LeverageYieldParams memory noAgent = sample();
        noAgent.agents = new address[](0);
        check(keccak256(T.install(good)) == keccak256(T.install(sample())), "the install is deterministic");
        check(T.install(noAgent).length < T.install(good).length, "no agent, no close role");
        emit log_named_uint("checks", passed);
    }

    function sample() internal view returns (LeverageYieldParams memory s) {
        address[] memory users = new address[](1);
        users[0] = address(0xB0B);
        address[] memory agents = new address[](1);
        agents[0] = agent;
        s = LeverageYieldParams(
            address(0xC05), address(0x6A7E), CBETH, POOL, USDC, address(0xFA17), 600e6, users, agents, false
        );
    }

    function refusedParams(TemplateProbe probe, LeverageYieldParams memory q, string memory reason) internal {
        try probe.validate(q) {
            revert(string.concat("accepted: ", reason));
        } catch (bytes memory err) {
            require(keccak256(err) == keccak256(abi.encodeWithSelector(T.InvalidParams.selector, reason)), reason);
        }
        passed++;
    }

    event log_named_uint(string, uint256);
}
