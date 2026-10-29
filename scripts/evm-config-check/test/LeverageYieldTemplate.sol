// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// The leverage-yield policy template for Prime on EVM, configuration only.
//
// This file is the one source of truth for the template: the fork test
// (test/LeverageYield.t.sol), the live script (script/LeverageYieldLive.s.sol)
// and the install script (script/LeverageYieldTemplate.s.sol) all build their
// Roles scopes and their batches from it. It is a library of internal pure
// functions that return calldata, so it is never deployed and adds no contract
// to any chain. What it writes is a set of Zodiac Roles v2.1.1 scopes on the
// custody gate (a Roles modifier whose avatar and target are the custody Safe);
// docs/evm-leverage-yield-template.md describes each one.
//
// Two roles:
// - OPEN_ROLE ("leverage-yield"), for the user members (the Prime account):
//   the open legs (approve the collateral to the pool, supply it for custody,
//   borrow the stablecoin for custody within the borrow cap, approve it to the
//   yield vault, deposit it for custody) and the close legs (redeem to custody,
//   approve the stablecoin to the pool, repay for custody, withdraw the
//   collateral to custody).
// - CLOSE_ROLE ("leverage-close"), for the agent members (the OctoPos agent):
//   the close legs only (redeem to custody, approve the stablecoin to the
//   pool, repay for custody, and withdraw the collateral to custody only when
//   agentWithdraw is set). An agent can lower the debt; it cannot borrow,
//   supply, deposit, or send anything anywhere but custody.
//
// Every recipient and onBehalfOf is pinned to the avatar (EqualToAvatar),
// approvals are pinned to the pool or the vault, no scope allows delegatecall
// or value, and any target or function not listed is refused by Roles.

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

interface IMultiSend {
    function multiSend(bytes memory) external payable;
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

/// The Aave v3 Pool functions the template scopes.
interface IPool {
    function supply(address, uint256, address, uint16) external;
    function withdraw(address, uint256, address) external returns (uint256);
    function borrow(address, uint256, uint256, uint16, address) external;
    function repay(address, uint256, uint256, address) external returns (uint256);
    function getUserAccountData(address) external view returns (uint256, uint256, uint256, uint256, uint256, uint256);
}

/// The ERC-4626 functions the template scopes on the yield vault.
interface IVault {
    function asset() external view returns (address);
    function deposit(uint256, address) external returns (uint256);
    function redeem(uint256, address, address) external returns (uint256);
}

/// The parameters of one install: one custody Safe, one gate, one market, one yield source.
struct LeverageYieldParams {
    address avatar; // the custody Safe: holds the collateral, the debt and the yield shares
    address gate; // the custody gate: a Roles v2.1.1 modifier, avatar and target = `avatar`, owner = `avatar`
    address collateral; // the tokenised gold (an Aave reserve listed as collateral)
    address pool; // the Aave v3 Pool
    address borrowAsset; // the stablecoin borrowed (an Aave reserve with borrowing on)
    address yieldVault; // an ERC-4626 vault whose asset() is `borrowAsset`
    uint128 borrowCap; // the borrow budget in `borrowAsset` units: the LTV signed at setup, absolute, no refill
    address[] users; // OPEN_ROLE members: the Prime account (its Safe signs the one-click batch)
    address[] agents; // CLOSE_ROLE members: the OctoPos agent (de-risk and close only); may be empty
    bool agentWithdraw; // whether an agent may also withdraw the collateral to custody (a full close)
}

library LeverageYieldTemplate {
    bytes32 internal constant OPEN_ROLE = "leverage-yield";
    bytes32 internal constant CLOSE_ROLE = "leverage-close";
    bytes32 internal constant BORROW_CAP = "leverage-borrow";

    // Canonical, same address on every chain Safe and Zodiac deploy to.
    address internal constant MULTISEND_CALL_ONLY = 0x9641d764fc13c8B624c04430C7356C1C7C8102e2; // Safe 1.4.1
    address internal constant MULTISEND_UNWRAPPER = 0x93B7fCbc63ED8a3a24B59e1C3e6649D50B7427c0; // Zodiac Roles

    uint256 internal constant VARIABLE = 2; // Aave v3 variable interest rate mode, the only one scoped

    // Roles v2.1.1 ParameterType
    uint8 internal constant NONE = 0;
    uint8 internal constant STATIC = 1;
    uint8 internal constant CALLDATA = 5;
    // Roles v2.1.1 Operator
    uint8 internal constant PASS = 0;
    uint8 internal constant OR = 2;
    uint8 internal constant MATCHES = 5;
    uint8 internal constant EQUAL_TO_AVATAR = 15;
    uint8 internal constant EQUAL_TO = 16;
    uint8 internal constant WITHIN_ALLOWANCE = 28;
    // Roles v2.1.1 ExecutionOptions: None (no value, no delegatecall)
    uint8 internal constant EXEC_NONE = 0;

    error InvalidParams(string reason);

    // ------------------------------------------------------------ validation

    /// Refuses a parameter set the template cannot install safely. Pure: it runs offline in the app
    /// before anything is signed. `verify` adds the chain reads.
    function validate(LeverageYieldParams memory p) internal pure {
        if (p.avatar == address(0)) revert InvalidParams("avatar is zero");
        if (p.gate == address(0)) revert InvalidParams("gate is zero");
        if (p.collateral == address(0)) revert InvalidParams("collateral is zero");
        if (p.pool == address(0)) revert InvalidParams("pool is zero");
        if (p.borrowAsset == address(0)) revert InvalidParams("borrow asset is zero");
        if (p.yieldVault == address(0)) revert InvalidParams("yield vault is zero");
        if (p.collateral == p.borrowAsset) revert InvalidParams("collateral is the borrow asset");
        if (p.borrowCap == 0) revert InvalidParams("borrow cap is zero");

        address[6] memory pinned = [p.avatar, p.gate, p.collateral, p.pool, p.borrowAsset, p.yieldVault];
        for (uint256 i; i < pinned.length; i++) {
            for (uint256 j = i + 1; j < pinned.length; j++) {
                if (pinned[i] == pinned[j]) revert InvalidParams("two roles share one address");
            }
        }

        if (p.users.length == 0) revert InvalidParams("no user member");
        _members(p, p.users);
        _members(p, p.agents);
        for (uint256 i; i < p.users.length; i++) {
            for (uint256 j; j < p.agents.length; j++) {
                if (p.users[i] == p.agents[j]) revert InvalidParams("a member is both user and agent");
            }
        }
        if (p.agentWithdraw && p.agents.length == 0) revert InvalidParams("agentWithdraw without an agent");
    }

    function _members(LeverageYieldParams memory p, address[] memory list) private pure {
        for (uint256 i; i < list.length; i++) {
            address m = list[i];
            if (m == address(0)) revert InvalidParams("member is zero");
            if (m == p.avatar || m == p.gate) revert InvalidParams("member is the custody Safe or the gate");
            if (m == p.collateral || m == p.pool || m == p.borrowAsset || m == p.yieldVault) {
                revert InvalidParams("member is a venue or token");
            }
            for (uint256 j = i + 1; j < list.length; j++) {
                if (list[j] == m) revert InvalidParams("duplicate member");
            }
        }
    }

    /// The chain reads `validate` cannot make: the gate is wired to the avatar and owned by it, and
    /// the yield vault takes the borrow asset. Run it against the chain before signing the install.
    function verify(LeverageYieldParams memory p) internal view {
        validate(p);
        IRoles g = IRoles(p.gate);
        if (g.avatar() != p.avatar || g.target() != p.avatar) revert InvalidParams("gate not wired to the avatar");
        if (g.owner() != p.avatar) revert InvalidParams("gate not owned by the avatar");
        if (IVault(p.yieldVault).asset() != p.borrowAsset) {
            revert InvalidParams("yield vault asset is not the borrow asset");
        }
    }

    // ------------------------------------------------------------ install

    /// The MultiSend entries the custody Safe signs (all custody signers) to install the template on its
    /// gate: the MultiSend unwrapper, the OPEN_ROLE scopes, the CLOSE_ROLE scopes, the borrow cap and the
    /// members. Append to the gate deployment entries, or send alone to an existing gate.
    function install(LeverageYieldParams memory p) internal pure returns (bytes memory) {
        validate(p);
        bytes memory out = abi.encodePacked(
            _gateCall(
                p,
                abi.encodeCall(
                    IRoles.setTransactionUnwrapper,
                    (MULTISEND_CALL_ONLY, IMultiSend.multiSend.selector, MULTISEND_UNWRAPPER)
                )
            ),
            _openRole(p),
            // the cap: an absolute budget, no refill (maxRefill, refill and period all zero)
            _gateCall(p, rearmCall(p.borrowCap)),
            _assign(p, p.users, OPEN_ROLE)
        );
        if (p.agents.length > 0) out = abi.encodePacked(out, _closeRole(p), _assign(p, p.agents, CLOSE_ROLE));
        return out;
    }

    /// Calldata for the gate, signed by custody: reset the borrow budget to `cap`. Repaying does not give
    /// the budget back, so a re-open after a close needs custody to re-arm it.
    function rearmCall(uint128 cap) internal pure returns (bytes memory) {
        return abi.encodeCall(IRoles.setAllowance, (BORROW_CAP, cap, 0, 0, 0, 0));
    }

    function _openRole(LeverageYieldParams memory p) private pure returns (bytes memory) {
        bytes32 r = OPEN_ROLE;
        bytes memory tokens = abi.encodePacked(
            _target(p, r, p.collateral),
            _fn(p, r, p.collateral, IERC20.approve.selector, approveTo(p.pool)),
            _target(p, r, p.borrowAsset),
            _fn(p, r, p.borrowAsset, IERC20.approve.selector, approveToEither(p.pool, p.yieldVault))
        );
        bytes memory pool = abi.encodePacked(
            _target(p, r, p.pool),
            _fn(p, r, p.pool, IPool.supply.selector, supplyScope(p.collateral)),
            _fn(p, r, p.pool, IPool.borrow.selector, borrowScope(p.borrowAsset)),
            _fn(p, r, p.pool, IPool.repay.selector, repayScope(p.borrowAsset)),
            _fn(p, r, p.pool, IPool.withdraw.selector, withdrawScope(p.collateral))
        );
        bytes memory vault = abi.encodePacked(
            _target(p, r, p.yieldVault),
            _fn(p, r, p.yieldVault, IVault.deposit.selector, depositScope()),
            _fn(p, r, p.yieldVault, IVault.redeem.selector, redeemScope())
        );
        return abi.encodePacked(tokens, pool, vault);
    }

    function _closeRole(LeverageYieldParams memory p) private pure returns (bytes memory) {
        bytes32 r = CLOSE_ROLE;
        bytes memory out = abi.encodePacked(
            _target(p, r, p.borrowAsset),
            _fn(p, r, p.borrowAsset, IERC20.approve.selector, approveTo(p.pool)),
            _target(p, r, p.pool),
            _fn(p, r, p.pool, IPool.repay.selector, repayScope(p.borrowAsset))
        );
        if (p.agentWithdraw) {
            out = abi.encodePacked(out, _fn(p, r, p.pool, IPool.withdraw.selector, withdrawScope(p.collateral)));
        }
        return abi.encodePacked(
            out, _target(p, r, p.yieldVault), _fn(p, r, p.yieldVault, IVault.redeem.selector, redeemScope())
        );
    }

    // ------------------------------------------------------------ the scopes

    /// approve(spender, amount): spender pinned to `spender`, amount open (the spender pin is the control).
    function approveTo(address spender) internal pure returns (ConditionFlat[] memory s) {
        s = new ConditionFlat[](3);
        s[0] = _c(0, CALLDATA, MATCHES, "");
        s[1] = _c(0, STATIC, EQUAL_TO, abi.encode(spender));
        s[2] = _c(0, STATIC, PASS, "");
    }

    /// approve(spender, amount): spender one of two pinned venues, amount open.
    function approveToEither(address a, address b) internal pure returns (ConditionFlat[] memory s) {
        s = new ConditionFlat[](5);
        s[0] = _c(0, CALLDATA, MATCHES, "");
        s[1] = _c(0, NONE, OR, "");
        s[2] = _c(0, STATIC, PASS, "");
        s[3] = _c(1, STATIC, EQUAL_TO, abi.encode(a));
        s[4] = _c(1, STATIC, EQUAL_TO, abi.encode(b));
    }

    /// supply(asset, amount, onBehalfOf, referral): the collateral, for custody.
    function supplyScope(address collateral) internal pure returns (ConditionFlat[] memory s) {
        s = new ConditionFlat[](5);
        s[0] = _c(0, CALLDATA, MATCHES, "");
        s[1] = _c(0, STATIC, EQUAL_TO, abi.encode(collateral));
        s[2] = _c(0, STATIC, PASS, "");
        s[3] = _c(0, STATIC, EQUAL_TO_AVATAR, "");
        s[4] = _c(0, STATIC, PASS, "");
    }

    /// borrow(asset, amount, rateMode, referral, onBehalfOf): the stablecoin, amount within the cap,
    /// variable rate, for custody.
    function borrowScope(address borrowAsset) internal pure returns (ConditionFlat[] memory s) {
        s = new ConditionFlat[](6);
        s[0] = _c(0, CALLDATA, MATCHES, "");
        s[1] = _c(0, STATIC, EQUAL_TO, abi.encode(borrowAsset));
        s[2] = _c(0, STATIC, WITHIN_ALLOWANCE, abi.encode(BORROW_CAP));
        s[3] = _c(0, STATIC, EQUAL_TO, abi.encode(VARIABLE));
        s[4] = _c(0, STATIC, PASS, "");
        s[5] = _c(0, STATIC, EQUAL_TO_AVATAR, "");
    }

    /// repay(asset, amount, rateMode, onBehalfOf): the stablecoin, any amount (max repays all), for custody.
    function repayScope(address borrowAsset) internal pure returns (ConditionFlat[] memory s) {
        s = new ConditionFlat[](5);
        s[0] = _c(0, CALLDATA, MATCHES, "");
        s[1] = _c(0, STATIC, EQUAL_TO, abi.encode(borrowAsset));
        s[2] = _c(0, STATIC, PASS, "");
        s[3] = _c(0, STATIC, EQUAL_TO, abi.encode(VARIABLE));
        s[4] = _c(0, STATIC, EQUAL_TO_AVATAR, "");
    }

    /// withdraw(asset, amount, to): the collateral, any amount (max withdraws all), to custody.
    function withdrawScope(address collateral) internal pure returns (ConditionFlat[] memory s) {
        s = new ConditionFlat[](4);
        s[0] = _c(0, CALLDATA, MATCHES, "");
        s[1] = _c(0, STATIC, EQUAL_TO, abi.encode(collateral));
        s[2] = _c(0, STATIC, PASS, "");
        s[3] = _c(0, STATIC, EQUAL_TO_AVATAR, "");
    }

    /// deposit(assets, receiver) on the vault: receiver is custody.
    function depositScope() internal pure returns (ConditionFlat[] memory s) {
        s = new ConditionFlat[](3);
        s[0] = _c(0, CALLDATA, MATCHES, "");
        s[1] = _c(0, STATIC, PASS, "");
        s[2] = _c(0, STATIC, EQUAL_TO_AVATAR, "");
    }

    /// redeem(shares, receiver, owner) on the vault: receiver and owner are custody.
    function redeemScope() internal pure returns (ConditionFlat[] memory s) {
        s = new ConditionFlat[](4);
        s[0] = _c(0, CALLDATA, MATCHES, "");
        s[1] = _c(0, STATIC, PASS, "");
        s[2] = _c(0, STATIC, EQUAL_TO_AVATAR, "");
        s[3] = _c(0, STATIC, EQUAL_TO_AVATAR, "");
    }

    // ------------------------------------------------------------ the batches a member signs

    /// OPEN: approve the collateral to the pool, supply it, borrow `borrowAmount`, approve it to the vault,
    /// deposit it. Run by a user member under OPEN_ROLE, all or nothing.
    function openBatch(LeverageYieldParams memory p, uint256 collateralAmount, uint256 borrowAmount)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            entry(p.collateral, abi.encodeCall(IERC20.approve, (p.pool, collateralAmount))),
            entry(p.pool, abi.encodeCall(IPool.supply, (p.collateral, collateralAmount, p.avatar, 0))),
            entry(p.pool, abi.encodeCall(IPool.borrow, (p.borrowAsset, borrowAmount, VARIABLE, 0, p.avatar))),
            entry(p.borrowAsset, abi.encodeCall(IERC20.approve, (p.yieldVault, borrowAmount))),
            entry(p.yieldVault, abi.encodeCall(IVault.deposit, (borrowAmount, p.avatar)))
        );
    }

    /// DE-RISK (rebalance): redeem `shares`, repay `repayAmount` of the debt. Runs under either role.
    function deleverageBatch(LeverageYieldParams memory p, uint256 shares, uint256 repayAmount)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            entry(p.yieldVault, abi.encodeCall(IVault.redeem, (shares, p.avatar, p.avatar))),
            entry(p.borrowAsset, abi.encodeCall(IERC20.approve, (p.pool, repayAmount))),
            entry(p.pool, abi.encodeCall(IPool.repay, (p.borrowAsset, repayAmount, VARIABLE, p.avatar)))
        );
    }

    /// CLOSE: redeem `shares`, repay the whole debt, and when `withdrawCollateral` withdraw all the
    /// collateral to custody. A user member may always withdraw; an agent only when agentWithdraw is set.
    function closeBatch(LeverageYieldParams memory p, uint256 shares, bool withdrawCollateral)
        internal
        pure
        returns (bytes memory out)
    {
        out = abi.encodePacked(
            entry(p.yieldVault, abi.encodeCall(IVault.redeem, (shares, p.avatar, p.avatar))),
            entry(p.borrowAsset, abi.encodeCall(IERC20.approve, (p.pool, type(uint256).max))),
            entry(p.pool, abi.encodeCall(IPool.repay, (p.borrowAsset, type(uint256).max, VARIABLE, p.avatar)))
        );
        if (withdrawCollateral) out = abi.encodePacked(out, withdrawEntry(p));
    }

    /// Withdraw all the collateral to custody (after the debt is gone).
    function withdrawEntry(LeverageYieldParams memory p) internal pure returns (bytes memory) {
        return entry(p.pool, abi.encodeCall(IPool.withdraw, (p.collateral, type(uint256).max, p.avatar)));
    }

    /// The calldata a member sends to the gate: one MultiSendCallOnly batch under `role`, which the
    /// Roles unwrapper splits so each leg is checked; `shouldRevert` true makes it all or nothing.
    function execCall(bytes32 role, bytes memory batch) internal pure returns (bytes memory) {
        return abi.encodeCall(
            IRoles.execTransactionWithRole,
            (MULTISEND_CALL_ONLY, 0, abi.encodeCall(IMultiSend.multiSend, (batch)), 1, role, true)
        );
    }

    /// One MultiSend entry: a plain call (operation 0) with no value.
    function entry(address to, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0), to, uint256(0), data.length, data);
    }

    // ------------------------------------------------------------ helpers

    function _gateCall(LeverageYieldParams memory p, bytes memory data) private pure returns (bytes memory) {
        return entry(p.gate, data);
    }

    function _target(LeverageYieldParams memory p, bytes32 role, address t) private pure returns (bytes memory) {
        return _gateCall(p, abi.encodeCall(IRoles.scopeTarget, (role, t)));
    }

    function _fn(LeverageYieldParams memory p, bytes32 role, address t, bytes4 sel, ConditionFlat[] memory s)
        private
        pure
        returns (bytes memory)
    {
        return _gateCall(p, abi.encodeCall(IRoles.scopeFunction, (role, t, sel, s, EXEC_NONE)));
    }

    function _assign(LeverageYieldParams memory p, address[] memory members, bytes32 role)
        private
        pure
        returns (bytes memory out)
    {
        bytes32[] memory roles = new bytes32[](1);
        roles[0] = role;
        bool[] memory on = new bool[](1);
        on[0] = true;
        for (uint256 i; i < members.length; i++) {
            out = abi.encodePacked(out, _gateCall(p, abi.encodeCall(IRoles.assignRoles, (members[i], roles, on))));
        }
    }

    function _c(uint8 parent, uint8 paramType, uint8 op, bytes memory comp)
        private
        pure
        returns (ConditionFlat memory)
    {
        return ConditionFlat(parent, paramType, op, comp);
    }
}
