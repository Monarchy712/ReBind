// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./RecoveryQueue.sol";
import "./RebindableRWA.sol";
import "./BindingRegistry.sol";

/**
 * @title RebindExecutor
 * @notice The single address permitted to move tokens out of a lost wallet.
 *
 * WHY A SEPARATE CONTRACT
 * -----------------------
 * The token grants recovery power to exactly ONE address. That address is this
 * contract, whose only function re-checks every precondition on the queue
 * before acting. It holds no keys, has no admin, and cannot be reconfigured.
 * The blast radius of the most dangerous capability in the system is therefore
 * a contract you can read top to bottom in thirty seconds.
 */
contract RebindExecutor {
    RecoveryQueue public immutable queue;
    RebindableRWA public immutable token;
    BindingRegistry public immutable registry;

    event RecoveryExecuted(
        uint256 indexed claimId,
        address indexed oldWallet,
        address indexed newWallet,
        uint256 amount,
        uint256 timestamp
    );

    error NotExecutable(uint256 claimId);
    error NothingToRecover(address oldWallet);
    error ZeroAddress();

    constructor(address queue_, address token_, address registry_) {
        if (queue_ == address(0) || token_ == address(0) || registry_ == address(0)) {
            revert ZeroAddress();
        }
        queue = RecoveryQueue(queue_);
        token = RebindableRWA(token_);
        registry = BindingRegistry(registry_);
    }

    /**
     * @notice Execute a matured, approved, uncancelled claim.
     *         Permissionless to call — every precondition is enforced by the
     *         queue, so there is nothing to gain by calling it for someone else.
     */
    function execute(uint256 claimId) external returns (uint256 amount) {
        if (!queue.isExecutable(claimId)) revert NotExecutable(claimId);

        RecoveryQueue.Claim memory c = queue.getClaim(claimId);

        amount = token.balanceOf(c.oldWallet);
        if (amount == 0) revert NothingToRecover(c.oldWallet);

        // Mark first, then move: the queue re-validates approval and window,
        // and flipping `executed` up front prevents re-entrant double spends.
        queue.markExecuted(claimId);
        token.recoveryTransfer(c.oldWallet, c.newWallet, amount);

        emit RecoveryExecuted(claimId, c.oldWallet, c.newWallet, amount, block.timestamp);
    }

    /// @notice What a given claim would move right now.
    function previewAmount(uint256 claimId) external view returns (uint256) {
        RecoveryQueue.Claim memory c = queue.getClaim(claimId);
        return token.balanceOf(c.oldWallet);
    }
}
