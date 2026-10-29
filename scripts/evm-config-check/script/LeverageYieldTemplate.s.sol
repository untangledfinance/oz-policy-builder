// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IMultiSend, LeverageYieldParams, LeverageYieldTemplate as T} from "../test/LeverageYieldTemplate.sol";

// Prints the transaction a custody Safe signs to install the leverage-yield template on its gate, for
// any account: the parameters come from the environment, the scopes from test/LeverageYieldTemplate.sol.
// It sends nothing. When the gate already exists on the chain it also runs the template's chain checks
// (gate wired to and owned by custody, the vault takes the borrow asset).
//
//   AVATAR=<custody Safe> GATE=<its Roles gate> COLLATERAL=<token> POOL=<Aave v3 pool> \
//   BORROW_ASSET=<stablecoin> YIELD_VAULT=<ERC-4626> BORROW_CAP=<units of the stablecoin> \
//   USERS=<addr,addr> [AGENTS=<addr,addr>] [AGENT_WITHDRAW=true] \
//   forge script script/LeverageYieldTemplate.s.sol --fork-url <rpc>
//
// The return values are the Safe transaction: to (MultiSend 1.4.1), operation 1 (delegatecall to
// MultiSend, as the Safe's own batches are), and the data. Custody signs it with all its signers.

interface VmT {
    function envAddress(string calldata) external view returns (address);
    function envAddress(string calldata, string calldata) external view returns (address[] memory);
    function envUint(string calldata) external view returns (uint256);
    function envOr(string calldata, bool) external view returns (bool);
    function envOr(string calldata, string calldata, address[] calldata) external view returns (address[] memory);
}

contract LeverageYieldTemplateInstall {
    VmT constant vm = VmT(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant MULTISEND = 0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526; // Safe 1.4.1, canonical

    function run() external view returns (address to, uint8 operation, bytes memory data) {
        uint256 cap = vm.envUint("BORROW_CAP");
        require(cap <= type(uint128).max, "BORROW_CAP above uint128");
        LeverageYieldParams memory p = LeverageYieldParams({
            avatar: vm.envAddress("AVATAR"),
            gate: vm.envAddress("GATE"),
            collateral: vm.envAddress("COLLATERAL"),
            pool: vm.envAddress("POOL"),
            borrowAsset: vm.envAddress("BORROW_ASSET"),
            yieldVault: vm.envAddress("YIELD_VAULT"),
            borrowCap: uint128(cap),
            users: vm.envAddress("USERS", ","),
            agents: vm.envOr("AGENTS", ",", new address[](0)),
            agentWithdraw: vm.envOr("AGENT_WITHDRAW", false)
        });
        if (p.gate.code.length > 0) T.verify(p);
        else T.validate(p);
        return (MULTISEND, 1, abi.encodeCall(IMultiSend.multiSend, (T.install(p))));
    }
}
