// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IERC1404 — Simple Restricted Token Standard
 * @notice The pre-flight interface for tokens that can refuse a transfer.
 *
 * WHY CONFORM RATHER THAN APPROXIMATE
 * -----------------------------------
 * A plain ERC-20 `transfer` answers exactly one question — does the sender
 * have the balance? A restricted asset needs to answer a second one — is this
 * recipient allowed to hold it? — and it needs to answer it *before* anyone
 * signs, or the holder learns the rule by losing gas to a revert.
 *
 * ERC-1404 is the agreed shape of that answer, and it is deliberately two
 * functions rather than one. `detectTransferRestriction` returns a numeric
 * code, which is cheap for a contract to branch on. `messageForTransferRestriction`
 * turns that code into human text, which is what a UI actually needs. Splitting
 * them means the machine-readable path costs no gas for strings it will never
 * display.
 *
 * Conforming matters here specifically: any ERC-1404-aware wallet, exchange or
 * compliance dashboard can query this token with no bespoke integration. An
 * approximation with a different signature is invisible to all of them.
 */
interface IERC1404 {
    /**
     * @notice Would this transfer be permitted right now?
     * @return restrictionCode 0 when the transfer is allowed; any other value
     *         is a reason code that `messageForTransferRestriction` explains.
     */
    function detectTransferRestriction(address from, address to, uint256 value)
        external
        view
        returns (uint8 restrictionCode);

    /// @notice Human-readable text for a code from `detectTransferRestriction`.
    function messageForTransferRestriction(uint8 restrictionCode)
        external
        view
        returns (string memory message);
}
