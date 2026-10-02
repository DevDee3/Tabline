// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Tabline} from "../src/Tabline.sol";

/// Usage:
///   forge script script/Deploy.s.sol --rpc-url arbitrum_sepolia --broadcast --private-key $DEPLOYER_PK
/// Then verify on Arbiscan with `forge verify-contract`.
contract Deploy is Script {
    function run() external returns (Tabline tabline) {
        vm.startBroadcast();
        tabline = new Tabline();
        vm.stopBroadcast();
        console2.log("Tabline deployed at", address(tabline));
        console2.log("chainid", block.chainid);
    }
}
