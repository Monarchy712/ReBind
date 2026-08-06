// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./BindingRegistry.sol";

/**
 * @title RebindableRWA
 * @notice A compliance-gated ERC-20 representing a restricted real-world asset,
 *         with an issuer-gated recovery path for lost or compromised wallets.
 *
 * THE GATE
 * --------
 * OpenZeppelin v5 routes EVERY balance change — transfer, transferFrom, _mint,
 * _burn — through the single internal function _update(). Overriding it once
 * covers every path with no bypass. That is the entire compliance mechanism.
 *
 *   from == address(0)  ->  mint
 *   to   == address(0)  ->  burn
 *   both non-zero       ->  ordinary transfer
 *
 * THE RECOVERY TRAP (read this before you change anything)
 * --------------------------------------------------------
 * recoveryTransfer() moves tokens OUT of a revoked wallet. But it calls
 * _transfer(), which calls _update(), which rejects revoked senders — which is
 * exactly who we are recovering from. Without a guard the function reverts on
 * its own gate.
 *
 * _inRecovery is a transient flag, set and cleared inside one transaction. It
 * can never be observed from outside, because by the time the transaction ends
 * it is false again. The destination is STILL fully verified during recovery —
 * we relax the sender check only, never the recipient check. Recovery is a
 * compliance feature, not a compliance bypass.
 */
contract RebindableRWA is ERC20, Ownable {
    BindingRegistry public immutable registry;

    /// The only address permitted to perform recovery transfers.
    address public executor;

    /// Transient guard. True only within a recoveryTransfer call.
    bool private _inRecovery;

    uint8 private immutable _decimals;

    event RecoveryTransfer(address indexed from, address indexed to, uint256 value);
    event ExecutorSet(address indexed executor);

    error RecipientNotEligible(address to);
    error SenderBindingRevoked(address from);
    error OnlyExecutor();
    error ZeroAddress();

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address registry_,
        address owner_
    ) ERC20(name_, symbol_) Ownable(owner_) {
        if (registry_ == address(0)) revert ZeroAddress();
        registry = BindingRegistry(registry_);
        _decimals = decimals_;
    }

    /// @dev Cleanverse A-Tokens use 6 like USDC. Pass 6 at deploy time.
    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    // ------------------------------------------------------------- admin

    function setExecutor(address executor_) external onlyOwner {
        if (executor_ == address(0)) revert ZeroAddress();
        executor = executor_;
        emit ExecutorSet(executor_);
    }

    /// @notice Issue the asset to a verified holder.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyOwner {
        _burn(from, amount);
    }

    // -------------------------------------------------------------- gate

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0)) {
            // MINT: only the recipient must be eligible.
            if (!registry.isActive(to)) revert RecipientNotEligible(to);
        } else if (to == address(0)) {
            // BURN: no recipient to check. Always permitted by the issuer.
        } else {
            // TRANSFER: both sides checked.
            // During recovery the sender is a revoked wallet by definition,
            // so that single check is suspended. The recipient check is not.
            if (!_inRecovery && registry.revoked(from)) {
                revert SenderBindingRevoked(from);
            }
            if (!registry.isActive(to)) revert RecipientNotEligible(to);
        }

        super._update(from, to, value);
    }

    // ---------------------------------------------------------- recovery

    /**
     * @notice Move an asset out of a lost/compromised wallet into a verified
     *         replacement belonging to the same person.
     * @dev Callable ONLY by RebindExecutor, which in turn only acts on claims
     *      that survived the cure window and received issuer approval.
     */
    function recoveryTransfer(address from, address to, uint256 value) external {
        if (msg.sender != executor) revert OnlyExecutor();
        if (!registry.isActive(to)) revert RecipientNotEligible(to);

        _inRecovery = true;
        _transfer(from, to, value);
        _inRecovery = false;

        emit RecoveryTransfer(from, to, value);
    }

    /// @notice Read-only pre-flight check, in the spirit of ERC-1404.
    ///         Lets a UI say WHY a transfer would fail, before signing.
    function detectTransferRestriction(address from, address to)
        external
        view
        returns (uint8 code, string memory reason)
    {
        if (!registry.isActive(from) && !registry.revoked(from)) return (1, "Sender has no A-Pass binding");
        if (registry.revoked(from))                return (2, "Sender binding revoked");
        if (!registry.isActive(to) && !registry.revoked(to)) return (3, "Recipient has no A-Pass binding");
        if (registry.revoked(to))                  return (4, "Recipient binding revoked");
        return (0, "Transfer allowed");
    }
}
