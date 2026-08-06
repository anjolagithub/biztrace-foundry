// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BizTrace} from "../src/BizTrace.sol";

contract BizTraceTest is Test {
    BizTrace public bizTrace;

    address public owner = address(this);
    address public scorer = makeAddr("scorer");
    address public merchant = makeAddr("merchant");
    address public other = makeAddr("other");

    function setUp() public {
        bizTrace = new BizTrace(scorer);
    }

    /*//////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////*/
    function test_ConstructorRevertsOnZeroScorer() public {
        vm.expectRevert(BizTrace.BizTrace__ZeroAddress.selector);
        new BizTrace(address(0));
    }

    function test_ConstructorSetsScorer() public view {
        assertEq(bizTrace.getScorer(), scorer);
    }

    /*//////////////////////////////////////////////////////////
                          REGISTER MERCHANT
    //////////////////////////////////////////////////////////*/
    function test_RegisterMerchant() public {
        vm.prank(merchant);
        vm.expectEmit(true, false, false, true);
        emit BizTrace.MerchantRegistered(merchant, "QmProofHash123");
        bizTrace.registerMerchant("QmProofHash123");

        (bool registered, bool verified,,, string memory proofHash,) = bizTrace.getCredential(merchant);
        assertTrue(registered);
        assertFalse(verified);
        assertEq(proofHash, "QmProofHash123");
    }

    function test_RevertOnEmptyProofHash() public {
        vm.prank(merchant);
        vm.expectRevert(BizTrace.BizTrace__EmptyProofHash.selector);
        bizTrace.registerMerchant("");
    }

    function test_ReRegisteringResetsVerification() public {
        vm.startPrank(merchant);
        bizTrace.registerMerchant("QmProofHash123");
        vm.stopPrank();

        vm.prank(scorer);
        bizTrace.submitScore(merchant, 85, "Gold");

        vm.prank(merchant);
        bizTrace.registerMerchant("QmNewProofHash456");

        (, bool verified, uint8 score,, string memory proofHash,) = bizTrace.getCredential(merchant);
        assertFalse(verified);
        assertEq(score, 0);
        assertEq(proofHash, "QmNewProofHash456");
    }

    /*//////////////////////////////////////////////////////////
                            SUBMIT SCORE
    //////////////////////////////////////////////////////////*/
    function test_OnlyScorerCanSubmitScore() public {
        vm.prank(merchant);
        bizTrace.registerMerchant("QmProofHash123");

        vm.prank(other);
        vm.expectRevert(BizTrace.BizTrace__NotScorer.selector);
        bizTrace.submitScore(merchant, 85, "Gold");
    }

    function test_ScorerCanSubmitScore() public {
        vm.prank(merchant);
        bizTrace.registerMerchant("QmProofHash123");

        vm.prank(scorer);
        vm.expectEmit(true, false, false, false);
        emit BizTrace.CredentialScored(merchant, 85, "Gold", uint64(block.timestamp));
        bizTrace.submitScore(merchant, 85, "Gold");

        (, bool verified, uint8 score, string memory tier,,) = bizTrace.getCredential(merchant);
        assertTrue(verified);
        assertEq(score, 85);
        assertEq(tier, "Gold");
    }

    function test_RevertOnScoringUnregisteredMerchant() public {
        vm.prank(scorer);
        vm.expectRevert(BizTrace.BizTrace__MerchantNotRegistered.selector);
        bizTrace.submitScore(merchant, 85, "Gold");
    }

    function test_RevertOnScoreAboveMax() public {
        vm.prank(merchant);
        bizTrace.registerMerchant("QmProofHash123");

        // Compute the out-of-range score BEFORE vm.expectRevert — expectRevert
        // only watches the very next external call, and calling getMaxScore()
        // inline here would itself be caught as "the next call" instead of
        // submitScore(), causing a false failure.
        uint8 outOfRangeScore = bizTrace.getMaxScore() + 1;

        vm.prank(scorer);
        vm.expectRevert(BizTrace.BizTrace__ScoreOutOfRange.selector);
        bizTrace.submitScore(merchant, outOfRangeScore, "Gold");
    }

    /*//////////////////////////////////////////////////////////
                             SET SCORER
    //////////////////////////////////////////////////////////*/
    function test_OnlyOwnerCanRotateScorer() public {
        vm.prank(other);
        vm.expectRevert();
        bizTrace.setScorer(other);
    }

    function test_OwnerCanRotateScorer() public {
        vm.expectEmit(true, true, false, false);
        emit BizTrace.ScorerUpdated(scorer, other);
        bizTrace.setScorer(other);

        assertEq(bizTrace.getScorer(), other);
    }

    function test_RevertOnZeroScorerRotation() public {
        vm.expectRevert(BizTrace.BizTrace__ZeroAddress.selector);
        bizTrace.setScorer(address(0));
    }

    /*//////////////////////////////////////////////////////////
                                FUZZ
    //////////////////////////////////////////////////////////*/
    function testFuzz_ScoreNeverExceedsMax(uint8 score) public {
        vm.prank(merchant);
        bizTrace.registerMerchant("QmProofHash123");

        uint8 maxScore = bizTrace.getMaxScore();

        vm.prank(scorer);
        if (score > maxScore) {
            vm.expectRevert(BizTrace.BizTrace__ScoreOutOfRange.selector);
            bizTrace.submitScore(merchant, score, "Gold");
        } else {
            bizTrace.submitScore(merchant, score, "Gold");
            (,, uint8 storedScore,,,) = bizTrace.getCredential(merchant);
            assertEq(storedScore, score);
            assertLe(storedScore, maxScore);
        }
    }

    function testFuzz_OnlyScorerEverSucceeds(address caller, uint8 score) public {
        vm.assume(caller != scorer);
        vm.assume(score <= bizTrace.getMaxScore());

        vm.prank(merchant);
        bizTrace.registerMerchant("QmProofHash123");

        vm.prank(caller);
        vm.expectRevert(BizTrace.BizTrace__NotScorer.selector);
        bizTrace.submitScore(merchant, score, "Gold");
    }
}