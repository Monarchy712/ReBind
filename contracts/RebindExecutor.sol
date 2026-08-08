// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./RecoveryQueue.sol";
import "./RebindableRWA.sol";
import "./BindingRegistry.sol";
import "./BridgeAdvanceVault.sol";

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

    /**
     * Optional. address(0) disables bridge advances entirely, and the executor
     * then behaves exactly as it did before they existed.
     *
     * Immutable like everything else here: a settable vault would mean an admin
     * could redirect recovered funds to an address of their choosing, which is
     * the one power this contract exists to not have.
     */
    BridgeAdvanceVault public immutable vault;

    event RecoveryExecuted(
        uint256 indexed claimId,
        address indexed oldWallet,
        address indexed newWallet,
        uint256 amount,
        uint256 timestamp
    );
    event AdvanceSettled(uint256 indexed claimId, uint256 noteToVault, uint256 noteToWallet);

    error NotExecutable(uint256 claimId);
    error NothingToRecover(address oldWallet);
    error ZeroAddress();

    /// @param vault_ Bridge advance vault, or address(0) for none.
    constructor(address queue_, address token_, address registry_, address vault_) {
        if (queue_ == address(0) || token_ == address(0) || registry_ == address(0)) {
            revert ZeroAddress();
        }
        queue = RecoveryQueue(queue_);
        token = RebindableRWA(token_);
        registry = BindingRegistry(registry_);
        vault = BridgeAdvanceVault(vault_);
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

        // Settle any bridge advance before the owner is paid. This ordering is
        // the entire security of the loan: there is no instant at which the
        // borrower holds the full balance and could choose not to repay.
        uint256 toVault = _settleAdvance(claimId, c.oldWallet, amount);
        uint256 toWallet = amount - toVault;

        if (toWallet > 0) {
            token.recoveryTransfer(c.oldWallet, c.newWallet, toWallet);
        }
        if (toVault > 0) {
            emit AdvanceSettled(claimId, toVault, toWallet);
        }

        emit RecoveryExecuted(claimId, c.oldWallet, c.newWallet, amount, block.timestamp);
    }

    /**
     * @dev Moves what is owed to the vault and tells it so. Returns the amount
     *      taken, capped at the balance actually available.
     *
     *      The cap matters: if the claim is worth less than was borrowed
     *      against it, the vault takes the shortfall rather than the recovery
     *      reverting. Stranding a rightful owner's asset because a lender is
     *      underwater would make the loan a hostage, and the vault chose that
     *      exposure when it set its LTV.
     */
    function _settleAdvance(uint256 claimId, address oldWallet, uint256 amount)
        private
        returns (uint256 toVault)
    {
        if (address(vault) == address(0)) return 0;

        toVault = vault.repaymentDue(claimId);
        if (toVault == 0) return 0;
        if (toVault > amount) toVault = amount;

        token.recoveryTransfer(oldWallet, address(vault), toVault);
        vault.settle(claimId, toVault);
    }

    /// @notice What a given claim would move right now.
    function previewAmount(uint256 claimId) external view returns (uint256) {
        RecoveryQueue.Claim memory c = queue.getClaim(claimId);
        return token.balanceOf(c.oldWallet);
    }

    /// @notice How that amount would split between the vault and the owner.
    function previewSplit(uint256 claimId)
        external
        view
        returns (uint256 total, uint256 toVault, uint256 toWallet)
    {
        RecoveryQueue.Claim memory c = queue.getClaim(claimId);
        total = token.balanceOf(c.oldWallet);

        if (address(vault) != address(0)) {
            toVault = vault.repaymentDue(claimId);
            if (toVault > total) toVault = total;
        }
        toWallet = total - toVault;
    }
}
