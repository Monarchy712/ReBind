// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IAdvanceOracle.sol";

/**
 * @title ParAdvanceOracle
 * @notice Values the note at par with the stable asset, correcting only for a
 *         difference in decimals.
 *
 * Correct for a dollar-denominated note redeemable at face value, which is what
 * the demo issues. It is NOT a price feed, and it is deliberately not
 * upgradeable or configurable: an oracle that an admin can silently re-point is
 * a strictly worse trust assumption than one that visibly cannot move at all.
 * To price a note that trades away from par, deploy a different implementation
 * of IAdvanceOracle and pass it to the vault.
 */
contract ParAdvanceOracle is IAdvanceOracle {
    uint8 public immutable noteDecimals;
    uint8 public immutable stableDecimals;

    error DecimalsTooLarge();

    constructor(uint8 noteDecimals_, uint8 stableDecimals_) {
        // Guards the scaling factors below against overflow, and rejects the
        // nonsense configurations early rather than at the first advance.
        if (noteDecimals_ > 36 || stableDecimals_ > 36) revert DecimalsTooLarge();
        noteDecimals = noteDecimals_;
        stableDecimals = stableDecimals_;
    }

    function noteToStable(uint256 noteAmount) external view returns (uint256) {
        if (stableDecimals >= noteDecimals) {
            return noteAmount * (10 ** (stableDecimals - noteDecimals));
        }
        return noteAmount / (10 ** (noteDecimals - stableDecimals));
    }

    function stableToNote(uint256 stableAmount) external view returns (uint256) {
        if (noteDecimals >= stableDecimals) {
            return stableAmount * (10 ** (noteDecimals - stableDecimals));
        }
        return stableAmount / (10 ** (stableDecimals - noteDecimals));
    }
}
