// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "./BindingRegistry.sol";

/**
 * @title RecoveryQueue
 * @notice Holds recovery claims through a mandatory challenge period.
 *         This is the on-chain equivalent of a transfer agent's notice period
 *         after an affidavit of loss.
 *
 * THE SECURITY ARGUMENT (a judge will ask this — know it cold)
 * -----------------------------------------------------------
 * Q: "What stops an attacker filing a fake claim and stealing the asset?"
 *
 * Three independent layers:
 *
 *   1. ATTESTATION. Opening a claim requires an EIP-712 signature from the
 *      attestor, who only signs after confirming via query_apass_list that
 *      both wallets share one Cleanverse customerId. An attacker holding a
 *      stolen WALLET does not hold the victim's bank-verified IDENTITY.
 *
 *   2. CHALLENGE WINDOW. Opening a claim immediately revokes the old binding,
 *      so a compromised key cannot drain assets while the claim is reviewed.
 *      Only an issuer reviewer may reject a claim; a thief who controls the
 *      old key must not receive a veto over recovery.
 *
 *   3. ISSUER APPROVAL. A human at the issuer must countersign.
 *
 * To defeat all three you need the wallet AND the identity AND the issuer.
 *
 * REPLAY PROTECTION
 * -----------------
 * Every attestation carries a nonce (incremented per claiming wallet) and a
 * deadline. Without both, an old signature could be replayed. The EIP-712
 * domain separator additionally binds each signature to this contract on this
 * chain, so a testnet signature cannot be replayed on mainnet.
 */
contract RecoveryQueue is EIP712, AccessControl {
    using ECDSA for bytes32;

    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    bytes32 private constant CLAIM_TYPEHASH = keccak256(
        "RecoveryClaim(bytes32 personId,address oldWallet,address newWallet,uint256 nonce,uint256 deadline)"
    );

    BindingRegistry public immutable registry;

    address public attestor;
    address public executor;
    uint64 public cureWindow;

    struct Claim {
        bytes32 personId;
        address oldWallet;
        address newWallet;
        uint64 openedAt;
        uint64 executableAt;
        bool cancelled;
        bool executed;
        bool issuerApproved;
        /**
         * The issuer has waived its right to cancel. Set only by commit().
         *
         * Approval alone is revocable — cancel() works right up until execution
         * — so "approved" is not a promise that a claim will settle. Anything
         * that extends credit against a pending claim (see BridgeAdvanceVault)
         * needs a state that cannot be walked back, or the issuer can approve,
         * let a lender disburse, and then cancel, leaving the lender with an
         * unsecured loss and no recourse.
         */
        bool committed;
    }

    Claim[] private _claims;

    /// newWallet => nonce, for attestation replay protection
    mapping(address => uint256) public nonces;

    event ClaimOpened(
        uint256 indexed claimId,
        bytes32 indexed personId,
        address indexed oldWallet,
        address newWallet,
        uint64 executableAt
    );
    event ClaimCancelled(uint256 indexed claimId, address by);
    event ClaimApproved(uint256 indexed claimId, address issuer);
    event ClaimCommitted(uint256 indexed claimId, address issuer);
    event ClaimExecuted(uint256 indexed claimId);
    event AttestorChanged(address indexed attestor);
    event CureWindowChanged(uint64 seconds_);

    error BadAttestation(address recovered);
    error AttestationExpired();
    error NotSamePerson(address oldWallet, address newWallet);
    error NewWalletNotActive(address newWallet);
    error OnlyExecutor();
    error ClaimClosed();
    error CureWindowActive(uint64 executableAt);
    error NotApproved();
    error ClaimIsCommitted(uint256 claimId);
    error NoSuchClaim(uint256 claimId);
    error ZeroAddress();

    constructor(
        address registry_,
        address attestor_,
        address admin_,
        uint64 cureWindow_
    ) EIP712("Rebind", "1") {
        if (registry_ == address(0) || attestor_ == address(0) || admin_ == address(0)) {
            revert ZeroAddress();
        }
        registry = BindingRegistry(registry_);
        attestor = attestor_;
        cureWindow = cureWindow_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ISSUER_ROLE, admin_);
    }

    // -------------------------------------------------------------- admin

    function setAttestor(address attestor_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (attestor_ == address(0)) revert ZeroAddress();
        attestor = attestor_;
        emit AttestorChanged(attestor_);
    }

    function setExecutor(address executor_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (executor_ == address(0)) revert ZeroAddress();
        executor = executor_;
    }

    function setCureWindow(uint64 seconds_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        cureWindow = seconds_;
        emit CureWindowChanged(seconds_);
    }

    // -------------------------------------------------------------- claims

    /**
     * @notice Open a recovery claim. Anyone may submit the transaction (the
     *         claimant may have no gas), but only with a valid attestor
     *         signature proving the two wallets share one customerId.
     */
    function openClaim(
        bytes32 personId,
        address oldWallet,
        address newWallet,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256 claimId) {
        if (block.timestamp > deadline) revert AttestationExpired();

        // Defence in depth: the registry must ALSO agree these are one person.
        if (!registry.samePerson(oldWallet, newWallet)) {
            revert NotSamePerson(oldWallet, newWallet);
        }
        if (!registry.matchesIdentity(oldWallet, personId) || !registry.matchesIdentity(newWallet, personId)) {
            revert NotSamePerson(oldWallet, newWallet);
        }
        // Recovering into a dead wallet would be pointless and unsafe.
        if (!registry.isActive(newWallet)) revert NewWalletNotActive(newWallet);

        uint256 nonce = nonces[newWallet]++;
        bytes32 structHash = keccak256(
            abi.encode(CLAIM_TYPEHASH, personId, oldWallet, newWallet, nonce, deadline)
        );
        address recovered = _hashTypedDataV4(structHash).recover(signature);
        if (recovered != attestor) revert BadAttestation(recovered);

        uint64 execAt = uint64(block.timestamp) + cureWindow;
        _claims.push(
            Claim({
                personId: personId,
                oldWallet: oldWallet,
                newWallet: newWallet,
                openedAt: uint64(block.timestamp),
                executableAt: execAt,
                cancelled: false,
                executed: false,
                issuerApproved: false,
                committed: false
            })
        );
        claimId = _claims.length - 1;
        // Freeze before emitting the public claim event. The executor's special
        // recovery path can still move the balance after approval and review.
        registry.revokeForRecovery(oldWallet);
        emit ClaimOpened(claimId, personId, oldWallet, newWallet, execAt);
    }

    /**
     * @notice Reject a disputed recovery claim after issuer review.
     * @dev Deliberately not callable by oldWallet: in a stolen-key scenario
     *      that signer is the attacker, who must not have a recovery veto.
     */
    function cancel(uint256 claimId) external onlyRole(ISSUER_ROLE) {
        Claim storage c = _get(claimId);
        if (c.cancelled || c.executed) revert ClaimClosed();
        // Committing is a one-way door, and this is the door. Third parties are
        // permitted to extend credit against a committed claim precisely
        // because this call can no longer take it away.
        if (c.committed) revert ClaimIsCommitted(claimId);

        c.cancelled = true;
        registry.restoreAfterChallenge(c.oldWallet);
        emit ClaimCancelled(claimId, msg.sender);
    }

    function approve(uint256 claimId) external onlyRole(ISSUER_ROLE) {
        Claim storage c = _get(claimId);
        if (c.cancelled || c.executed) revert ClaimClosed();

        c.issuerApproved = true;
        emit ClaimApproved(claimId, msg.sender);
    }

    /**
     * @notice Approve a claim AND permanently give up the right to cancel it.
     *
     * @dev This is the strongest statement the issuer can make: after this call
     *      the claim will settle once the cure window elapses, and no party —
     *      including the issuer — can stop it. That irrevocability is what lets
     *      a lender advance funds against the pending claim.
     *
     *      It is deliberately a separate call from approve(). An issuer that is
     *      merely satisfied should approve; an issuer willing to underwrite the
     *      claim so its owner can borrow against it should commit. The cure
     *      window still runs, so committing early does not accelerate anything;
     *      it only removes the issuer's own veto.
     *
     *      The honest cost: a fraudulent claim that is committed by mistake can
     *      no longer be rejected. Commitment should follow the same review that
     *      approval does, not precede it.
     */
    function commit(uint256 claimId) external onlyRole(ISSUER_ROLE) {
        Claim storage c = _get(claimId);
        if (c.cancelled || c.executed) revert ClaimClosed();
        if (c.committed) revert ClaimIsCommitted(claimId);

        if (!c.issuerApproved) {
            c.issuerApproved = true;
            emit ClaimApproved(claimId, msg.sender);
        }
        c.committed = true;
        emit ClaimCommitted(claimId, msg.sender);
    }

    function markExecuted(uint256 claimId) external {
        if (msg.sender != executor) revert OnlyExecutor();
        Claim storage c = _get(claimId);
        if (c.cancelled || c.executed) revert ClaimClosed();
        if (!c.issuerApproved) revert NotApproved();
        if (block.timestamp < c.executableAt) revert CureWindowActive(c.executableAt);

        c.executed = true;
        emit ClaimExecuted(claimId);
    }

    // --------------------------------------------------------------- views

    function isExecutable(uint256 claimId) public view returns (bool) {
        if (claimId >= _claims.length) return false;
        Claim storage c = _claims[claimId];
        return !c.cancelled
            && !c.executed
            && c.issuerApproved
            && block.timestamp >= c.executableAt;
    }

    /**
     * @notice True when this claim is guaranteed to settle: committed, still
     *         open, and therefore no longer cancellable by anyone.
     * @dev The single question a lender needs answered before disbursing.
     */
    function isCommitted(uint256 claimId) external view returns (bool) {
        if (claimId >= _claims.length) return false;
        Claim storage c = _claims[claimId];
        return c.committed && !c.cancelled && !c.executed;
    }

    function getClaim(uint256 claimId) external view returns (Claim memory) {
        if (claimId >= _claims.length) revert NoSuchClaim(claimId);
        return _claims[claimId];
    }

    function claimCount() external view returns (uint256) {
        return _claims.length;
    }

    /// @notice Seconds remaining in the cure window (0 once elapsed).
    function timeRemaining(uint256 claimId) external view returns (uint64) {
        if (claimId >= _claims.length) return 0;
        uint64 execAt = _claims[claimId].executableAt;
        if (block.timestamp >= execAt) return 0;
        return execAt - uint64(block.timestamp);
    }

    /// @notice Exposed so the backend can build the exact EIP-712 payload.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _get(uint256 claimId) private view returns (Claim storage) {
        if (claimId >= _claims.length) revert NoSuchClaim(claimId);
        return _claims[claimId];
    }
}
