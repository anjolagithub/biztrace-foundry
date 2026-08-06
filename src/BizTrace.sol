// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title BizTrace
 * @author BizTrace
 * @notice On-chain trust credentials for African merchants, scored by an AI
 *         legitimacy-verification pipeline. Credentials are non-transferable
 *         (soulbound) and can be read by any BOT Chain app (marketplaces,
 *         lenders, payment agents) to gate access or pricing decisions.
 * @dev Follows the Cyfrin Updraft style guide: custom errors instead of
 *      require-strings, CEI-ordered functions, grouped state/events, and a
 *      fixed layout (errors -> types -> state -> events -> modifiers ->
 *      constructor -> external -> public -> internal -> view/pure).
 */
contract BizTrace is Ownable {
    /*//////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////*/
    error BizTrace__ZeroAddress();
    error BizTrace__EmptyProofHash();
    error BizTrace__NotScorer();
    error BizTrace__MerchantNotRegistered();
    error BizTrace__ScoreOutOfRange();

    /*//////////////////////////////////////////////////////////
                           TYPE DECLARATIONS
    //////////////////////////////////////////////////////////*/
    struct Credential {
        bool registered; // merchant has submitted proof
        bool verified; // AI has returned a score for this merchant
        uint8 score; // 0-100 legitimacy score
        string tier; // e.g. "Unverified", "Bronze", "Silver", "Gold"
        string proofHash; // hash/CID of submitted business proof documents
        uint64 scoredAt; // timestamp of last score update
    }

    /*//////////////////////////////////////////////////////////
                           STATE VARIABLES
    //////////////////////////////////////////////////////////*/
    uint8 private constant MAX_SCORE = 100;

    /// @notice Address of the off-chain AI scoring service allowed to submit scores.
    address private s_scorer;

    mapping(address merchant => Credential credential) private s_credentials;

    /*//////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////*/
    event MerchantRegistered(address indexed merchant, string proofHash);
    event CredentialScored(address indexed merchant, uint8 score, string tier, uint64 scoredAt);
    event ScorerUpdated(address indexed oldScorer, address indexed newScorer);

    /*//////////////////////////////////////////////////////////
                               MODIFIERS
    //////////////////////////////////////////////////////////*/
    modifier onlyScorer() {
        if (msg.sender != s_scorer) revert BizTrace__NotScorer();
        _;
    }

    /*//////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////*/
    constructor(address initialScorer) Ownable(msg.sender) {
        if (initialScorer == address(0)) revert BizTrace__ZeroAddress();
        s_scorer = initialScorer;
    }

    /*//////////////////////////////////////////////////////////
                          EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////*/

    /**
     * @notice Merchant submits a hash/CID pointing to their business proof
     *         (registration docs, utility bill, ID, etc. stored off-chain).
     * @param proofHash Hash or CID of the off-chain proof documents.
     */
    function registerMerchant(string calldata proofHash) external {
        if (bytes(proofHash).length == 0) revert BizTrace__EmptyProofHash();

        Credential storage credential = s_credentials[msg.sender];
        credential.registered = true;
        credential.proofHash = proofHash;
        // Re-registering resets verification until the scorer re-evaluates.
        credential.verified = false;
        credential.score = 0;
        credential.tier = "Unverified";

        emit MerchantRegistered(msg.sender, proofHash);
    }

    /**
     * @notice Called by the off-chain AI scoring service after evaluating a
     *         merchant's submitted proof.
     * @param merchant Address of the merchant being scored.
     * @param score Legitimacy score from 0 to 100.
     * @param tier Human-readable tier derived from the score (e.g. "Gold").
     */
    function submitScore(address merchant, uint8 score, string calldata tier) external onlyScorer {
        if (!s_credentials[merchant].registered) revert BizTrace__MerchantNotRegistered();
        if (score > MAX_SCORE) revert BizTrace__ScoreOutOfRange();

        Credential storage credential = s_credentials[merchant];
        credential.verified = true;
        credential.score = score;
        credential.tier = tier;
        credential.scoredAt = uint64(block.timestamp);

        emit CredentialScored(merchant, score, tier, credential.scoredAt);
    }

    /**
     * @notice Owner can rotate the scoring service address (e.g. key rotation).
     * @param newScorer New address permitted to call submitScore().
     */
    function setScorer(address newScorer) external onlyOwner {
        if (newScorer == address(0)) revert BizTrace__ZeroAddress();
        emit ScorerUpdated(s_scorer, newScorer);
        s_scorer = newScorer;
    }

    /*//////////////////////////////////////////////////////////
                     EXTERNAL / PUBLIC VIEW FUNCTIONS
    //////////////////////////////////////////////////////////*/

    /// @notice Read a merchant's current credential.
    function getCredential(address merchant)
        external
        view
        returns (bool registered, bool verified, uint8 score, string memory tier, string memory proofHash, uint64 scoredAt)
    {
        Credential storage credential = s_credentials[merchant];
        return (
            credential.registered,
            credential.verified,
            credential.score,
            credential.tier,
            credential.proofHash,
            credential.scoredAt
        );
    }

    /// @notice Returns the address currently allowed to submit scores.
    function getScorer() external view returns (address) {
        return s_scorer;
    }

    /// @notice Returns the maximum possible legitimacy score.
    function getMaxScore() external pure returns (uint8) {
        return MAX_SCORE;
    }
}