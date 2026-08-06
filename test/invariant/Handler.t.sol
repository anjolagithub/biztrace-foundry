// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BizTrace} from "../../src/BizTrace.sol";

/**
 * @title Handler
 * @notice Bounds the invariant fuzzer's calls to BizTrace so it explores
 *         realistic sequences (register -> score -> re-register -> ...)
 *         instead of wasting runs on calls that revert immediately.
 */
contract Handler is Test {
    BizTrace public bizTrace;
    address public scorer;

    address[] public actors;

    constructor(BizTrace _bizTrace, address _scorer) {
        bizTrace = _bizTrace;
        scorer = _scorer;
        for (uint256 i = 0; i < 5; i++) {
            actors.push(makeAddr(string.concat("actor", vm.toString(i))));
        }
    }

    function registerMerchant(uint256 actorSeed, string calldata proofHash) public {
        if (bytes(proofHash).length == 0) return; // would revert, not the property under test
        address actor = actors[actorSeed % actors.length];
        vm.prank(actor);
        bizTrace.registerMerchant(proofHash);
    }

    function submitScore(uint256 actorSeed, uint8 score) public {
        address actor = actors[actorSeed % actors.length];
        (bool registered,,,,,) = bizTrace.getCredential(actor);
        if (!registered) return;

        uint8 boundedScore = uint8(bound(score, 0, bizTrace.getMaxScore()));
        vm.prank(scorer);
        bizTrace.submitScore(actor, boundedScore, "Gold");
    }
}