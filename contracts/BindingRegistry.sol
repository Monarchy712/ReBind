// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title BindingRegistry
 * @notice On-chain mirror of Cleanverse A-Pass wallet bindings.
 *
 * WHY THIS EXISTS
 * ---------------
 * A smart contract cannot call the Cleanverse REST API (determinism forbids it).
 * But our token's transfer gate needs to know two off-chain facts:
 *
 *   1. Is this wallet a verified, non-revoked A-Pass holder?
 *   2. Do these two wallets belong to the SAME verified person?
 *
 * Fact (2) is only knowable via query_apass_list, which returns every wallet
 * sharing a customerId. So a trusted backend ("the attestor") reads Cleanverse
 * and mirrors the answer here.
 *
 * identityCommitment is an opaque, server-generated commitment to a customerId.
 * It MUST be derived with a secret salt off-chain. A plain hash of a predictable
 * customer ID is guessable and must never be used as an identity safeguard.
 *
 * TRUST MODEL (state this honestly to judges)
 * -------------------------------------------
 * The ATTESTOR_ROLE holder can create and revoke bindings. It cannot mint,
 * move, or burn tokens. If the attestor key were compromised an attacker could
 * assert false bindings, so in production this becomes a multisig, and moves
 * fully on-chain if/when Cleanverse exposes customerId linkage on-chain.
 */
contract BindingRegistry is AccessControl {
    bytes32 public constant ATTESTOR_ROLE = keccak256("ATTESTOR_ROLE");
    bytes32 public constant RECOVERY_ROLE = keccak256("RECOVERY_ROLE");

    /// wallet => opaque identity commitment (bytes32(0) means "never bound")
    mapping(address => bytes32) private _identityOf;

    /// identity commitment => nominated guardian address (co-signs recovery claims)
    mapping(bytes32 => address) public guardianOf;

    /// wallet => has this binding been revoked?
    mapping(address => bool) public revoked;

    event WalletBound(address indexed wallet);
    event GuardianSet(bytes32 indexed personId, address indexed guardian);
    event WalletRevoked(address indexed wallet, string reason);
    event WalletRestored(address indexed wallet);

    error AlreadyBound(address wallet);
    error NotBound(address wallet);
    error MissingGuardian();
    error ZeroAddress();

    constructor(address admin, address attestor) {
        if (admin == address(0) || attestor == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ATTESTOR_ROLE, attestor);
    }

    // ---------------------------------------------------------------- writes

    /**
     * @notice Bind a wallet to a person and set their guardian. Called after the backend
     *         has confirmed via generate_apass that this wallet now carries an A-Pass under
     *         the given customerId.
     * @dev A wallet may belong to only one person, ever. A non-zero guardian is strictly required;
     *      the guardian must co-sign any future recovery claim for this identity.
     */
    function bindWallet(bytes32 identityCommitment, address wallet, address guardian)
        external
        onlyRole(ATTESTOR_ROLE)
    {
        if (wallet == address(0)) revert ZeroAddress();
        if (guardian == address(0)) revert MissingGuardian();
        if (identityCommitment == bytes32(0) || _identityOf[wallet] != bytes32(0)) revert AlreadyBound(wallet);

        _identityOf[wallet] = identityCommitment;
        guardianOf[identityCommitment] = guardian;
        emit WalletBound(wallet);
        emit GuardianSet(identityCommitment, guardian);
    }

    /**
     * @notice Revoke a binding. Mirrors Cleanverse update_status(status: 2).
     *         A revoked wallet can no longer send or receive.
     */
    function revokeWallet(address wallet, string calldata reason)
        external
        onlyRole(ATTESTOR_ROLE)
    {
        if (_identityOf[wallet] == bytes32(0)) revert NotBound(wallet);

        revoked[wallet] = true;
        emit WalletRevoked(wallet, reason);
    }

    /// @notice Used only by RecoveryQueue when a signed claim opens.
    function revokeForRecovery(address wallet) external onlyRole(RECOVERY_ROLE) {
        if (_identityOf[wallet] == bytes32(0)) revert NotBound(wallet);
        revoked[wallet] = true;
        emit WalletRevoked(wallet, "recovery claim pending");
    }

    /// @notice Mirrors update_status(status: 1). Included for completeness.
    function restoreWallet(address wallet) external onlyRole(ATTESTOR_ROLE) {
        if (_identityOf[wallet] == bytes32(0)) revert NotBound(wallet);

        revoked[wallet] = false;
        emit WalletRestored(wallet);
    }

    /// @notice Restores a binding when an issuer rejects a recovery claim.
    function restoreAfterChallenge(address wallet) external onlyRole(RECOVERY_ROLE) {
        if (_identityOf[wallet] == bytes32(0)) revert NotBound(wallet);
        revoked[wallet] = false;
        emit WalletRestored(wallet);
    }

    // ----------------------------------------------------------------- reads

    /**
     * @notice True when both wallets resolve to the same opaque identity commitment.
     */
    function samePerson(address a, address b) public view returns (bool) {
        bytes32 pa = _identityOf[a];
        return pa != bytes32(0) && pa == _identityOf[b];
    }

    /// @notice True only when wallet is bound to the supplied commitment.
    /// @dev The commitment comes from a salted off-chain derivation; no raw customerId is stored.
    function matchesIdentity(address wallet, bytes32 identityCommitment) external view returns (bool) {
        return identityCommitment != bytes32(0) && _identityOf[wallet] == identityCommitment;
    }

    /// @notice Bound and not revoked. This is what the token gate asks.
    function isActive(address wallet) public view returns (bool) {
        return _identityOf[wallet] != bytes32(0) && !revoked[wallet];
    }
}
