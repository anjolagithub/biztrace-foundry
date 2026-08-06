// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {BizTrace} from "../../src/BizTrace.sol";
import {Handler} from "./Handler.t.sol";

/**
 * @title BizTraceInvariantTest
 * @notice Protocol-level properties that must hold no matter what sequence
 *         of valid calls the fuzzer throws at the system.
 */
contract BizTraceInvariantTest is StdInvariant, Test {
    BizTrace public bizTrace;
    Handler public handler;

    address public scorer = makeAddr("scorer");

    function setUp() public {
        bizTrace = new BizTrace(scorer);
        handler = new Handler(bizTrace, scorer);

        targetContract(address(handler));
    }

    /// @notice No stored score can ever exceed the contract's own max score,
    ///         regardless of how many register/score cycles ran.
    function invariant_ScoreNeverExceedsMax() public view {
        uint8 maxScore = bizTrace.getMaxScore();
        for (uint256 i = 0; i < 5; i++) {
            address actor = handler.actors(i);
            (,, uint8 score,,,) = bizTrace.getCredential(actor);
            assertLe(score, maxScore);
        }
    }

    /// @notice A credential can only be "verified" if it is also "registered" —
    ///         you can never be verified without having registered first.
    function invariant_VerifiedImpliesRegistered() public view {
        for (uint256 i = 0; i < 5; i++) {
            address actor = handler.actors(i);
            (bool registered, bool verified,,,,) = bizTrace.getCredential(actor);
            if (verified) {
                assertTrue(registered);
            }
        }
    }

    /// @notice The scorer address never becomes the zero address through any
    ///         reachable call path.
    function invariant_ScorerNeverZero() public view {
        assertTrue(bizTrace.getScorer() != address(0));
    }
}