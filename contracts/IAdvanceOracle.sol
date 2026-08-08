// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IAdvanceOracle
 * @notice Converts between the restricted note and the stable asset a bridge
 *         advance is paid out in.
 *
 * WHY AN INTERFACE FOR SOMETHING THIS SMALL
 * -----------------------------------------
 * The demo values a dollar-denominated Series A note at par, which needs no
 * price feed at all. That will not survive contact with a note that trades at a
 * discount, an amortising instrument, or any asset whose value moves. Putting
 * the conversion behind an interface means the vault never learns where the
 * price came from, and swapping ParAdvanceOracle for a real feed is a
 * constructor argument rather than a rewrite.
 *
 * Implementations MUST be monotonic and MUST NOT revert for reasonable inputs;
 * the vault calls them inside execution, where a revert would strand a recovery.
 */
interface IAdvanceOracle {
    /// @notice Value `noteAmount` of the restricted note, denominated in the stable asset.
    function noteToStable(uint256 noteAmount) external view returns (uint256);

    /// @notice How much of the restricted note is worth `stableAmount`.
    function stableToNote(uint256 stableAmount) external view returns (uint256);
}
