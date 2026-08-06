// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./BindingRegistry.sol";
import "./IERC1404.sol";

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
contract RebindableRWA is ERC20, Ownable, IERC1404 {
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

    // ----------------------------------------------------------- ERC-1404

    /// No restriction. ERC-1404 fixes 0 as "allowed"; the rest are ours.
    uint8 public constant SUCCESS = 0;
    uint8 public constant SENDER_UNBOUND = 1;
    uint8 public constant SENDER_REVOKED = 2;
    uint8 public constant RECIPIENT_UNBOUND = 3;
    uint8 public constant RECIPIENT_REVOKED = 4;
    uint8 public constant INSUFFICIENT_BALANCE = 5;

    /**
     * @notice Would this transfer be permitted right now?
     * @dev Mirrors the order of checks in `_update`, so a caller that sees
     *      SUCCESS here and still reverts is a bug worth knowing about.
     *      Recovery is deliberately not modelled: it is not a transfer any
     *      caller can initiate, so reporting it as permitted would be a lie.
     */
    function detectTransferRestriction(address from, address to, uint256 value)
        external
        view
        override
        returns (uint8)
    {
        if (!registry.isActive(from) && !registry.revoked(from)) return SENDER_UNBOUND;
        if (registry.revoked(from)) return SENDER_REVOKED;
        if (!registry.isActive(to) && !registry.revoked(to)) return RECIPIENT_UNBOUND;
        if (registry.revoked(to)) return RECIPIENT_REVOKED;
        // Checked last: an ineligible counterparty is the more useful thing to
        // report, and it does not change by topping up the balance.
        if (balanceOf(from) < value) return INSUFFICIENT_BALANCE;
        return SUCCESS;
    }

    /// @notice Human-readable text for a code from `detectTransferRestriction`.
    function messageForTransferRestriction(uint8 restrictionCode)
        external
        pure
        override
        returns (string memory)
    {
        if (restrictionCode == SUCCESS) return "Transfer allowed";
        if (restrictionCode == SENDER_UNBOUND) return "Sender has no A-Pass binding";
        if (restrictionCode == SENDER_REVOKED) return "Sender binding revoked";
        if (restrictionCode == RECIPIENT_UNBOUND) return "Recipient has no A-Pass binding";
        if (restrictionCode == RECIPIENT_REVOKED) return "Recipient binding revoked";
        if (restrictionCode == INSUFFICIENT_BALANCE) return "Insufficient balance";
        return "Unknown restriction code";
    }
}
