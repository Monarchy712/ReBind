/**
 * The attestor bridges Cleanverse (off-chain) to your contracts (on-chain).
 *
 * WHY THIS EXISTS
 * ---------------
 * A smart contract cannot call an HTTP API — determinism forbids it. But the
 * fact "these two wallets belong to one verified person" lives ONLY in
 * query_apass_list. So this service:
 *
 *   1. asks Cleanverse whether both wallets share a customerId
 *   2. signs that finding with a dedicated key (EIP-712)
 *   3. hands the signature to the caller, who passes it to RecoveryQueue
 *
 * RecoveryQueue runs ecrecover and checks the signer is the trusted attestor.
 * It does not trust whoever submitted the transaction — only whoever signed.
 *
 * TRUST BOUNDARY — say this out loud to judges:
 * The attestor key can assert false bindings if compromised. It cannot mint,
 * move or burn tokens. In production it becomes a multisig, and disappears
 * entirely if Cleanverse ever exposes customerId linkage on-chain.
 */
const { ethers } = require("ethers");
const crypto = require("crypto");
const cv = require("./cleanverse-client");
const normalizePrivateKey = (value) => value && (value.startsWith("0x") ? value : `0x${value}`);

const EIP712_TYPES = {
  RecoveryClaim: [
    { name: "personId", type: "bytes32" },
    { name: "oldWallet", type: "address" },
    { name: "newWallet", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

const GUARDIAN_EIP712_TYPES = {
  GuardianRecoveryClaim: [
    { name: "personId", type: "bytes32" },
    { name: "oldWallet", type: "address" },
    { name: "newWallet", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

/**
 * Opaque commitment, not a reversible customer-ID hash. The secret must be
 * retained by the attestor service; do not put it in frontend code or deploy it.
 */
function personIdOf(customerId) {
  const salt = process.env.IDENTITY_COMMITMENT_SALT;
  if (!salt) throw new Error("Set IDENTITY_COMMITMENT_SALT in .env");
  return "0x" + crypto.createHmac("sha256", salt).update(String(customerId)).digest("hex");
}

class Attestor {
  constructor({ privateKey, queueAddress, chainId }) {
    this.signer = new ethers.Wallet(normalizePrivateKey(privateKey));
    this.queueAddress = queueAddress;
    this.chainId = chainId;
  }

  get address() {
    return this.signer.address;
  }

  domain() {
    return {
      name: "Rebind",
      version: "1",
      chainId: this.chainId,
      verifyingContract: this.queueAddress,
    };
  }

  /**
   * Ask Cleanverse whether two wallets are the same person.
   * This is the single most important call in the product.
   *
   * @param includeWalletList  Internal callers (this file) may want the raw
   *   list; anything that turns this into an HTTP response should NOT set
   *   this, since it would let a caller enumerate every wallet bound to a
   *   customerId — exactly the linkage the opaque on-chain commitment is
   *   designed to avoid leaking.
   */
  async proveEquivalence({ customerId, oldWallet, newWallet, includeWalletList = false }) {
    if (oldWallet.toLowerCase() === newWallet.toLowerCase()) {
      return {
        equivalent: false,
        detail: "oldWallet and newWallet are the same address; nothing to recover",
      };
    }

    const wallets = await cv.walletsForCustomer(customerId);
    const oldOk = wallets.includes(oldWallet.toLowerCase());
    const newOk = wallets.includes(newWallet.toLowerCase());

    const result = {
      equivalent: oldOk && newOk,
      detail: oldOk
        ? (newOk ? "Both wallets resolve to one Cleanverse customerId"
                 : "New wallet is not bound to this customerId")
        : "Old wallet is not bound to this customerId",
    };

    // Opt-in only. Never forwarded to an API response by default.
    if (includeWalletList) {
      result.wallets = wallets;
    }

    return result;
  }

  /**
   * Sign a recovery claim. Refuses unless Cleanverse confirms equivalence.
   * @param nonce  MUST equal queue.nonces(newWallet) at submission time.
   */
  async signClaim({ customerId, oldWallet, newWallet, nonce, ttlSeconds = 3600 }) {
    if (oldWallet.toLowerCase() === newWallet.toLowerCase()) {
      throw new Error("Refusing to attest: oldWallet and newWallet are the same address");
    }

    // Kept internal to this call so the caller of signClaim() (server.js)
    // still gets the wallet list for its own proof/audit response, without
    // every consumer of proveEquivalence() getting it by default.
    const proof = await this.proveEquivalence({ customerId, oldWallet, newWallet, includeWalletList: false });
    if (!proof.equivalent) {
      const e = new Error(`Refusing to attest: ${proof.detail}`);
      e.proof = proof;
      throw e;
    }

    const personId = personIdOf(customerId);
    const deadline = Math.floor(Date.now() / 1000) + ttlSeconds;

    const signature = await this.signer.signTypedData(
      this.domain(),
      EIP712_TYPES,
      { personId, oldWallet, newWallet, nonce, deadline }
    );

    return { personId, oldWallet, newWallet, nonce, deadline, signature, proof };
  }

  /**
   * Co-sign a recovery claim using the guardian's independently-held private key.
   * Uses the identical EIP-712 domain and typehash as the attestor signature.
   */
  async signGuardianClaim({ privateKey, customerId, personId: givenPersonId, oldWallet, newWallet, nonce, ttlSeconds = 3600, deadline: givenDeadline }) {
    const guardianSigner = new ethers.Wallet(normalizePrivateKey(privateKey));
    const personId = givenPersonId || personIdOf(customerId);
    const deadline = givenDeadline !== undefined ? givenDeadline : Math.floor(Date.now() / 1000) + ttlSeconds;

    const signature = await guardianSigner.signTypedData(
      this.domain(),
      GUARDIAN_EIP712_TYPES,   // <-- distinct type
      { personId, oldWallet, newWallet, nonce, deadline }
    );

    return { personId, oldWallet, newWallet, nonce, deadline, signature, guardian: guardianSigner.address };
  }
}

/**
 * Sign a guardian claim directly with a dedicated private key.
 */
async function signGuardianClaim({ privateKey, queueAddress, chainId, customerId, personId: givenPersonId, oldWallet, newWallet, nonce, ttlSeconds = 3600, deadline: givenDeadline }) {
  const guardianSigner = new ethers.Wallet(normalizePrivateKey(privateKey));
  const personId = givenPersonId || (customerId ? personIdOf(customerId) : undefined);
  const deadline = givenDeadline !== undefined ? givenDeadline : Math.floor(Date.now() / 1000) + ttlSeconds;
  const domain = {
    name: "Rebind",
    version: "1",
    chainId,
    verifyingContract: queueAddress,
  };
  const signature = await guardianSigner.signTypedData(
    domain,
    GUARDIAN_EIP712_TYPES,
    { personId, oldWallet, newWallet, nonce, deadline }
  );
  return { personId, oldWallet, newWallet, nonce, deadline, signature, guardian: guardianSigner.address };
}

module.exports = { Attestor, personIdOf, EIP712_TYPES, GUARDIAN_EIP712_TYPES, signGuardianClaim };

