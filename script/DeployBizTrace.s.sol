// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {BizTrace} from "../src/BizTrace.sol";

contract DeployBizTrace is Script {
    function run() external returns (BizTrace) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        address scorerAddress = vm.envOr("SCORER_ADDRESS", deployer);

        console.log("Deploying BizTrace with account:", deployer);
        console.log("Scorer address set to:", scorerAddress);

        vm.startBroadcast(deployerPrivateKey);
        BizTrace bizTrace = new BizTrace(scorerAddress);
        vm.stopBroadcast();

        console.log("BizTrace deployed to:", address(bizTrace));
        console.log("Verify on explorer once confirmed:");
        console.log("  Testnet: https://scan.bohr.life/address/", address(bizTrace));
        console.log("  Mainnet: https://scan.botchain.ai/address/", address(bizTrace));

        return bizTrace;
    }
}