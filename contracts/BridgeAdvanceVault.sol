// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./RecoveryQueue.sol";
import "./RebindableRWA.sol";
import "./IAdvanceOracle.sol";

/**
 * @title BridgeAdvanceVault
 * @notice Lends against a recovery claim that is still inside its cure window.
 *
 * THE PROBLEM
 * -----------
 * A recovery claim freezes the holder's asset for the length of the cure window
 * — 48 hours in a realistic deployment. The freeze is the point: it stops a
 * stolen key moving the asset while a human checks the claim. But the honest
 * owner is frozen by exactly the same mechanism, and an asset she cannot spend,
 * sell or post as collateral is of no use to her if the window falls across a
 * rent payment.
 *
 * She is not poor during those 48 hours. She is illiquid, against a receivable
 * that is about to settle. This vault prices that receivable.
 *
 * WHAT MAKES IT LENDABLE (this is the whole design)
 * -------------------------------------------------
 * A pending claim is not by itself collateral, because approve() is revocable:
 * cancel() works right up until execution, so an issuer could approve, watch a
 * lender disburse, then cancel and leave the lender with nothing to collect
 * against. This vault therefore refuses to look at approved claims. It lends
 * only against COMMITTED ones — RecoveryQueue.commit() is a one-way door after
 * which no party, including the issuer, can stop the claim settling.
 *
 * So the credit assessment is not "will the issuer honour this?" It is "has the
 * issuer already permanently given up the ability not to?"
 *
 * HOW REPAYMENT CANNOT BE AVOIDED
 * -------------------------------
 * Repayment is not a promise the borrower keeps. RebindExecutor asks this vault
 * what is owed and routes that much of the recovered balance here in the same
 * transaction that settles the claim, before the remainder reaches the
 * borrower's new wallet. There is no moment at which the borrower holds the
 * full balance and could decline to repay.
 *
 * WHAT THE VAULT STILL RISKS (state this plainly)
 * -----------------------------------------------
 *   1. The old wallet's balance falls between draw and settlement. It cannot be
 *      spent — the wallet is frozen — but the issuer can still burn, and a
 *      redemption or corporate action could reduce it. The LTV haircut is the
 *      buffer, and RebindExecutor caps repayment at whatever actually arrives,
 *      so the vault absorbs any shortfall rather than stranding the recovery.
 *   2. Price. Repayment arrives in the restricted note, not in the stable that
 *      was lent, so the vault runs long the note and short stables. At par with
 *      a redeemable note that is an inventory question; with a note that trades
 *      at a discount it is a solvency question, and the LTV must reflect it.
 *   3. The note is transfer-restricted, so the vault must itself hold an active
 *      A-Pass binding or it cannot receive repayment at all. Losing that
 *      binding would strand every outstanding advance.
 */
contract BridgeAdvanceVault is AccessControl, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE");

    bytes32 private constant AUTH_TYPEHASH = keccak256(
        "AdvanceAuthorization(uint256 claimId,address borrower,uint256 nonce,uint256 deadline)"
    );

    uint16 public constant BPS = 10_000;

    RecoveryQueue public immutable queue;
    RebindableRWA public immutable note;
    IERC20 public immutable stable;

    IAdvanceOracle public oracle;
    address public executor;

    /// Share of the claim's value advanced. The rest is the safety margin.
    uint16 public ltvBps;
    /// Origination fee, charged on principal and collected in the note.
    uint16 public feeBps;

    struct Advance {
        address borrower;
        uint128 principalStable;
        /// Note owed at settlement: principal + fee, converted at draw time.
        uint128 dueNote;
        bool drawn;
        bool repaid;
    }

    /// claimId => advance
    mapping(uint256 => Advance) private _advances;

    /// borrower => nonce, for authorisation replay protection
    mapping(address => uint256) public advanceNonces;

    uint256 public totalPrincipalOutstanding;

    event AdvanceDrawn(
        uint256 indexed claimId,
        address indexed borrower,
        uint256 principalStable,
        uint256 dueNote
    );
    event AdvanceRepaid(uint256 indexed claimId, uint256 noteReceived, uint256 shortfallNote);
    event LiquidityDeposited(address indexed from, uint256 amount);
    event LiquidityWithdrawn(address indexed to, uint256 amount);
    event TermsChanged(uint16 ltvBps, uint16 feeBps);
    event OracleChanged(address indexed oracle);
    event ExecutorChanged(address indexed executor);

    error ZeroAddress();
    error ClaimNotCommitted(uint256 claimId);
    error NotBorrower(address caller, address borrower);
    error AlreadyDrawn(uint256 claimId);
    error NothingToBorrowAgainst(uint256 claimId);
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error RepaymentExceedsClaim(uint256 dueNote, uint256 claimNote);
    error OnlyExecutor();
    error NoAdvance(uint256 claimId);
    error BadTerms();
    error AuthorizationExpired();
    error BadAuthorization(address recovered);

    constructor(
        address queue_,
        address note_,
        address stable_,
        address oracle_,
        address admin_,
        uint16 ltvBps_,
        uint16 feeBps_
    ) EIP712("RebindAdvance", "1") {
        if (
            queue_ == address(0) || note_ == address(0) || stable_ == address(0)
                || oracle_ == address(0) || admin_ == address(0)
        ) revert ZeroAddress();
        if (ltvBps_ == 0 || ltvBps_ > BPS || feeBps_ > BPS) revert BadTerms();

        queue = RecoveryQueue(queue_);
        note = RebindableRWA(note_);
        stable = IERC20(stable_);
        oracle = IAdvanceOracle(oracle_);
        ltvBps = ltvBps_;
        feeBps = feeBps_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(TREASURY_ROLE, admin_);
    }

    // ---------------------------------------------------------------- admin

    /**
     * @dev The executor is set after deployment because the executor's
     *      constructor takes the vault address — one of the two has to come
     *      second. Restricted to admin and expected to be called once, during
     *      deployment wiring.
     */
    function setExecutor(address executor_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (executor_ == address(0)) revert ZeroAddress();
        executor = executor_;
        emit ExecutorChanged(executor_);
    }

    function setOracle(address oracle_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (oracle_ == address(0)) revert ZeroAddress();
        oracle = IAdvanceOracle(oracle_);
        emit OracleChanged(oracle_);
    }

    /// @dev Only affects advances drawn afterwards; outstanding ones keep their terms.
    function setTerms(uint16 ltvBps_, uint16 feeBps_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (ltvBps_ == 0 || ltvBps_ > BPS || feeBps_ > BPS) revert BadTerms();
        ltvBps = ltvBps_;
        feeBps = feeBps_;
        emit TermsChanged(ltvBps_, feeBps_);
    }

    function depositLiquidity(uint256 amount) external onlyRole(TREASURY_ROLE) {
        stable.safeTransferFrom(msg.sender, address(this), amount);
        emit LiquidityDeposited(msg.sender, amount);
    }

    /**
     * @notice Withdraw idle stable liquidity.
     * @dev Deliberately cannot touch the note balance: that is repayment the
     *      vault has already received and must be able to account for
     *      separately from float.
     */
    function withdrawLiquidity(address to, uint256 amount) external onlyRole(TREASURY_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        uint256 free = stable.balanceOf(address(this));
        if (amount > free) revert InsufficientLiquidity(amount, free);
        stable.safeTransfer(to, amount);
        emit LiquidityWithdrawn(to, amount);
    }

    /// @notice Sweep repaid notes to the treasury, which is where they get redeemed.
    function sweepNotes(address to, uint256 amount) external onlyRole(TREASURY_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        IERC20(address(note)).safeTransfer(to, amount);
    }

    // --------------------------------------------------------------- quoting

    /**
     * @notice What this claim could borrow right now.
     * @return principalStable Stable paid out.
     * @return dueNote         Note collected at settlement (principal + fee).
     * @dev Returns (0, 0) rather than reverting when a claim is ineligible, so
     *      a UI can ask about any claim without special-casing.
     */
    function quote(uint256 claimId)
        public
        view
        returns (uint256 principalStable, uint256 dueNote)
    {
        if (!queue.isCommitted(claimId)) return (0, 0);
        if (_advances[claimId].drawn) return (0, 0);

        RecoveryQueue.Claim memory c = queue.getClaim(claimId);
        uint256 claimNote = note.balanceOf(c.oldWallet);
        if (claimNote == 0) return (0, 0);

        principalStable = (oracle.noteToStable(claimNote) * ltvBps) / BPS;
        if (principalStable == 0) return (0, 0);

        uint256 owedStable = principalStable + (principalStable * feeBps) / BPS;
        dueNote = oracle.stableToNote(owedStable);
    }

    // ---------------------------------------------------------------- borrow

    /**
     * @notice Draw an advance against a committed claim.
     * @dev Callable only by the claim's new wallet — the party who will receive
     *      the recovered asset, and therefore the only one whose repayment can
     *      be intercepted at settlement.
     */
    function draw(uint256 claimId) external nonReentrant returns (uint256 principalStable) {
        RecoveryQueue.Claim memory c = queue.getClaim(claimId);
        if (msg.sender != c.newWallet) revert NotBorrower(msg.sender, c.newWallet);
        return _draw(claimId, c);
    }

    /**
     * @notice Draw on behalf of a borrower who signed an authorisation.
     *
     * @dev The wallet recovering an asset may hold no gas — that is a normal
     *      consequence of the situation it is in — so openClaim already lets
     *      anyone submit on a claimant's behalf. This mirrors that: consent is
     *      the borrower's EIP-712 signature, not the transaction sender.
     *
     *      Proceeds still go to the claim's new wallet, so a relayer gains
     *      nothing by submitting. The nonce and deadline stop an old
     *      authorisation being replayed after the borrower changed their mind.
     */
    function drawWithAuthorization(uint256 claimId, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
        returns (uint256 principalStable)
    {
        if (block.timestamp > deadline) revert AuthorizationExpired();

        RecoveryQueue.Claim memory c = queue.getClaim(claimId);

        uint256 nonce = advanceNonces[c.newWallet]++;
        bytes32 structHash = keccak256(
            abi.encode(AUTH_TYPEHASH, claimId, c.newWallet, nonce, deadline)
        );
        address recovered = _hashTypedDataV4(structHash).recover(signature);
        if (recovered != c.newWallet) revert BadAuthorization(recovered);

        return _draw(claimId, c);
    }

    /// @notice Exposed so a client can build the exact EIP-712 payload.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _draw(uint256 claimId, RecoveryQueue.Claim memory c)
        private
        returns (uint256 principalStable)
    {
        if (!queue.isCommitted(claimId)) revert ClaimNotCommitted(claimId);

        Advance storage a = _advances[claimId];
        if (a.drawn) revert AlreadyDrawn(claimId);

        uint256 dueNote;
        (principalStable, dueNote) = quote(claimId);
        if (principalStable == 0) revert NothingToBorrowAgainst(claimId);

        // Never lend against more than the claim can repay. With ltvBps < BPS
        // and a fee that keeps principal+fee under par this cannot trigger, but
        // a mispriced oracle or exotic terms could, and silently under-securing
        // the vault is the failure worth being loud about.
        uint256 claimNote = note.balanceOf(c.oldWallet);
        if (dueNote > claimNote) revert RepaymentExceedsClaim(dueNote, claimNote);

        uint256 available = stable.balanceOf(address(this));
        if (principalStable > available) revert InsufficientLiquidity(principalStable, available);

        _advances[claimId] = Advance({
            borrower: c.newWallet,
            principalStable: uint128(principalStable),
            dueNote: uint128(dueNote),
            drawn: true,
            repaid: false
        });
        totalPrincipalOutstanding += principalStable;

        emit AdvanceDrawn(claimId, c.newWallet, principalStable, dueNote);
        stable.safeTransfer(c.newWallet, principalStable);
    }

    // -------------------------------------------------------------- settling

    /**
     * @notice Note owed at settlement, or 0 if there is nothing to collect.
     * @dev RebindExecutor calls this while executing. It must never revert, or
     *      an unrelated bug here would permanently strand a recovery.
     */
    function repaymentDue(uint256 claimId) external view returns (uint256) {
        Advance storage a = _advances[claimId];
        if (!a.drawn || a.repaid) return 0;
        return a.dueNote;
    }

    /**
     * @notice Record that the executor has delivered repayment.
     * @param noteReceived What the executor actually transferred, which may be
     *        less than owed if the claim's balance fell after the draw.
     * @dev Trusts the executor for the amount, which is safe because the
     *      executor is the only address the note will accept a recovery
     *      transfer from, so it is already fully trusted with the balance.
     */
    function settle(uint256 claimId, uint256 noteReceived) external {
        if (msg.sender != executor) revert OnlyExecutor();

        Advance storage a = _advances[claimId];
        if (!a.drawn || a.repaid) revert NoAdvance(claimId);

        a.repaid = true;
        totalPrincipalOutstanding -= a.principalStable;

        uint256 shortfall = noteReceived >= a.dueNote ? 0 : a.dueNote - noteReceived;
        emit AdvanceRepaid(claimId, noteReceived, shortfall);
    }

    // ----------------------------------------------------------------- views

    function getAdvance(uint256 claimId) external view returns (Advance memory) {
        return _advances[claimId];
    }

    function hasOutstandingAdvance(uint256 claimId) external view returns (bool) {
        Advance storage a = _advances[claimId];
        return a.drawn && !a.repaid;
    }

    /// @notice Stable available to lend right now.
    function availableLiquidity() external view returns (uint256) {
        return stable.balanceOf(address(this));
    }
}
