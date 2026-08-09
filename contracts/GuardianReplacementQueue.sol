// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "./BindingRegistry.sol";
import "./RecoveryQueue.sol";

/**
 * @title GuardianReplacementQueue
 * @notice Manages requests to replace an identity's recovery guardian.
 *
 * THE SECURITY ARGUMENT
 * ---------------------
 * Q: "What stops an attacker filing a fake request to change the guardian to one they control?"
 *
 * Guardian replacement is needed when the existing guardian is unreachable, lost, or compromised.
 * Therefore, we cannot require a co-signature from the current guardian.
 * Instead, security is maintained via three independent layers:
 *
 *   1. IDENTITY RE-VERIFICATION (ATTESTATION). Opening a request requires an EIP-712 signature from
 *      the attestor, who only signs after performing a fresh Cleanverse identity check on the requesting
 *      wallet. The attestor queries queryApass({ address: wallet }) to ensure the A-Pass is active and matches
 *      the customerId, and walletsForCustomer(customerId) to confirm the wallet is actively bound to that identity.
 *      An attacker holding a stolen key/wallet without the victim's verified identity cannot pass this check.
 *
 *   2. CURE WINDOW. Opening a request starts a public challenge window (cureWindow). This gives the owner
 *      and the issuer time to inspect the pending request.
 *
 *   3. ISSUER VETO (CANCEL). The issuer can cancel any request during the cure window if dispute or compromise
 *      is detected.
 *
 * WHY WALLETS ARE NOT FROZEN
 * --------------------------
 * Unlike RecoveryQueue.openClaim (which calls revokeForRecovery to freeze a wallet to prevent asset drain
 * during recovery), a guardian replacement request does NOT freeze or revoke the wallet. Guardian replacement
 * is a maintenance operation performed on an active, functional identity. Freezing the wallet during this
 * window would create a high-friction denial-of-service vector against honest users who simply need to update
 * their setup. Since the assets are not immediately at risk of being moved to a new wallet, we leave the
 * requesting wallet fully active.
 *
 * REPLAY PROTECTION
 * -----------------
 * Every request carries a nonce (incremented per requesting wallet in `nonces`) and a deadline.
 * The signature additionally embeds the expected `oldGuardian` address. If the guardian is changed via some other
 * path, the request becomes invalid. The EIP-712 domain separator binds signatures to this contract and chain.
 */
contract GuardianReplacementQueue is EIP712, AccessControl {
    using ECDSA for bytes32;

    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    bytes32 private constant GUARDIAN_CHANGE_TYPEHASH = keccak256(
        "GuardianChangeRequest(bytes32 personId,address wallet,address oldGuardian,address newGuardian,uint256 nonce,uint256 deadline)"
    );

    BindingRegistry public immutable registry;
    RecoveryQueue public immutable recoveryQueue;

    address public attestor;
    uint64 public cureWindow;

    struct GuardianChangeRequest {
        bytes32 personId;
        address wallet;
        address oldGuardian;
        address newGuardian;
        uint64 openedAt;
        uint64 executableAt;
        bool cancelled;
        bool finalized;
    }

    GuardianChangeRequest[] private _requests;

    /// wallet => nonce, for EIP-712 replay protection
    mapping(address => uint256) public nonces;

    /// personId => id of its one active (open, not cancelled/finalized) request
    mapping(bytes32 => uint256) public activeRequestOf;
    mapping(bytes32 => bool) public hasActiveRequest;

    event RequestOpened(
        uint256 indexed requestId,
        bytes32 indexed personId,
        address indexed wallet,
        address oldGuardian,
        address newGuardian,
        uint64 executableAt
    );
    event RequestCancelled(uint256 indexed requestId, address by);
    event RequestFinalized(uint256 indexed requestId, address newGuardian);
    event AttestorChanged(address indexed attestor);
    event CureWindowChanged(uint64 seconds_);

    error BadAttestation(address recovered);
    error AttestationExpired();
    error NewGuardianCannotBeZero();
    error NewGuardianCannotBeWallet(address newGuardian);
    error SameGuardian(address newGuardian);
    error RequestAlreadyActive(bytes32 personId, uint256 existingRequestId);
    error RecoveryClaimActive(address wallet);
    error RequestClosed();
    error CureWindowActive(uint64 executableAt);
    error StaleGuardian(address expected, address actual);
    error IdentityMismatch(address wallet, bytes32 personId);
    error WalletNotActive(address wallet);
    error NoSuchRequest(uint256 requestId);
    error ZeroAddress();

    constructor(
        address registry_,
        address recoveryQueue_,
        address attestor_,
        address admin_,
        uint64 cureWindow_
    ) EIP712("RebindGuardian", "1") {
        if (registry_ == address(0) || recoveryQueue_ == address(0) || attestor_ == address(0) || admin_ == address(0)) {
            revert ZeroAddress();
        }
        registry = BindingRegistry(registry_);
        recoveryQueue = RecoveryQueue(recoveryQueue_);
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

    function setCureWindow(uint64 seconds_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        cureWindow = seconds_;
        emit CureWindowChanged(seconds_);
    }

    // -------------------------------------------------------------- requests

    function openRequest(
        bytes32 personId,
        address wallet,
        address oldGuardian,
        address newGuardian,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256 requestId) {
        if (block.timestamp > deadline) revert AttestationExpired();
        if (newGuardian == address(0)) revert NewGuardianCannotBeZero();
        if (newGuardian == wallet) revert NewGuardianCannotBeWallet(newGuardian);

        // Check blocking states first to ensure active claim reverts with RecoveryClaimActive even if wallet was revoked/frozen by that claim
        if (recoveryQueue.hasActiveClaim(wallet)) revert RecoveryClaimActive(wallet);
        if (hasActiveRequest[personId]) revert RequestAlreadyActive(personId, activeRequestOf[personId]);

        // Check wallet identity alignment and activity
        if (!registry.matchesIdentity(wallet, personId)) revert IdentityMismatch(wallet, personId);
        if (!registry.isActive(wallet)) revert WalletNotActive(wallet);

        address liveOldGuardian = registry.guardianOf(personId);
        if (newGuardian == liveOldGuardian) revert SameGuardian(newGuardian);
        if (oldGuardian != liveOldGuardian) revert StaleGuardian(oldGuardian, liveOldGuardian);

        uint256 nonce = nonces[wallet]++;

        bytes32 structHash = keccak256(
            abi.encode(
                GUARDIAN_CHANGE_TYPEHASH,
                personId,
                wallet,
                oldGuardian,
                newGuardian,
                nonce,
                deadline
            )
        );

        bytes32 digest = _hashTypedDataV4(structHash);
        address recoveredAttestor = digest.recover(signature);
        if (recoveredAttestor != attestor) revert BadAttestation(recoveredAttestor);

        uint64 execAt = uint64(block.timestamp) + cureWindow;
        _requests.push(
            GuardianChangeRequest({
                personId: personId,
                wallet: wallet,
                oldGuardian: oldGuardian,
                newGuardian: newGuardian,
                openedAt: uint64(block.timestamp),
                executableAt: execAt,
                cancelled: false,
                finalized: false
            })
        );
        requestId = _requests.length - 1;

        activeRequestOf[personId] = requestId;
        hasActiveRequest[personId] = true;

        emit RequestOpened(requestId, personId, wallet, oldGuardian, newGuardian, execAt);
    }

    function cancel(uint256 requestId) external onlyRole(ISSUER_ROLE) {
        GuardianChangeRequest storage r = _get(requestId);
        if (r.cancelled || r.finalized) revert RequestClosed();

        r.cancelled = true;
        hasActiveRequest[r.personId] = false;
        emit RequestCancelled(requestId, msg.sender);
    }

    function finalize(uint256 requestId) external {
        GuardianChangeRequest storage r = _get(requestId);
        if (r.cancelled || r.finalized) revert RequestClosed();
        if (block.timestamp < r.executableAt) revert CureWindowActive(r.executableAt);

        r.finalized = true;
        hasActiveRequest[r.personId] = false;

        registry.updateGuardian(r.personId, r.newGuardian);
        emit RequestFinalized(requestId, r.newGuardian);
    }

    function getRequest(uint256 requestId) external view returns (GuardianChangeRequest memory) {
        if (requestId >= _requests.length) revert NoSuchRequest(requestId);
        return _requests[requestId];
    }

    function requestCount() external view returns (uint256) {
        return _requests.length;
    }

    function timeRemaining(uint256 requestId) external view returns (uint64) {
        if (requestId >= _requests.length) return 0;
        uint64 execAt = _requests[requestId].executableAt;
        if (block.timestamp >= execAt) return 0;
        return execAt - uint64(block.timestamp);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _get(uint256 requestId) private view returns (GuardianChangeRequest storage) {
        if (requestId >= _requests.length) revert NoSuchRequest(requestId);
        return _requests[requestId];
    }
}
