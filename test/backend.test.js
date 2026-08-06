/**
 * Backend unit tests.
 *
 * The contract suite covers the chain. Nothing covered the two off-chain pieces
 * that a demo actually fails on: the AES envelope Cleanverse requires, and the
 * attestor's refusal to sign for wallets that are not the same person.
 *
 * These run fully offline. `fetch` is stubbed, so no sandbox record is created
 * and no credential is needed — the suite passes on a fresh clone with no .env.
 */
const { expect } = require("chai");
const crypto = require("crypto");
const { ethers } = require("ethers");

// Pin the credentials BEFORE requiring the client: it reads them at module load
// and throws if they are absent. A fixed 32-byte key keeps ciphertext stable.
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.CV_API_ID = "APPTESTID0000000000";
process.env.CV_API_KEY = TEST_KEY;
process.env.CV_BASE_URL = "https://uatapi.example.invalid/api/cooperate";
process.env.IDENTITY_COMMITMENT_SALT = "test-salt-do-not-use-in-production";

const cv = require("../backend/cleanverse");
const { Attestor, personIdOf, EIP712_TYPES } = require("../backend/attestor");

/** Swap in a canned response for the next fetch, and capture what was sent. */
function stubFetch(payload, { status = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts, body: opts?.body ? JSON.parse(opts.body) : null });
    return { status, json: async () => payload };
  };
  return calls;
}

describe("Backend", function () {
  let realFetch;
  beforeEach(function () { realFetch = globalThis.fetch; });
  afterEach(function () { globalThis.fetch = realFetch; });

  describe("Cleanverse — AES envelope", function () {
    // Trap #5 in the handbook: a 403 means the encryption is wrong, not auth.
    // Every one of these asserts a property that, if broken, produces that 403.

    it("round-trips through AES-256-CBC with a 16-zero-byte IV", function () {
      const payload = { customerId: "REBINDALICE001", status: "2" };
      const decipher = crypto.createDecipheriv(
        "aes-256-cbc", Buffer.from(TEST_KEY, "base64"), Buffer.alloc(16, 0)
      );
      const plain = Buffer.concat([
        decipher.update(Buffer.from(cv.encrypt(payload), "base64")),
        decipher.final(),
      ]).toString("utf8");

      expect(JSON.parse(plain)).to.deep.equal(payload);
    });

    it("base64-decodes the key before use, rather than using the raw string", function () {
      // Using the key as raw UTF-8 is the single most common cause of the 403.
      // It is not 32 bytes, so AES-256 cannot even be constructed.
      expect(Buffer.from(TEST_KEY, "base64")).to.have.lengthOf(32);
      expect(() => crypto.createCipheriv(
        "aes-256-cbc", Buffer.from(TEST_KEY, "utf8"), Buffer.alloc(16, 0)
      )).to.throw();
    });

    it("uses a FIXED iv, so the same payload always encrypts identically", function () {
      // A random IV would be more secure but Cleanverse cannot decrypt it.
      expect(cv.encrypt({ a: 1 })).to.equal(cv.encrypt({ a: 1 }));
    });

    it("sends encrypted bodies as {data: ciphertext}, never as plaintext fields", async function () {
      const calls = stubFetch({ code: "0000", message: "ok" });
      await cv.updateStatus({
        customerId: "REBINDALICE001", address: "0x" + "a".repeat(40),
        status: 2, reason: "recovery claim pending",
      });

      expect(Object.keys(calls[0].body)).to.deep.equal(["data"]);
      expect(JSON.stringify(calls[0].body)).to.not.include("REBINDALICE001");
    });

    it("sends plain endpoints unencrypted, so the two paths cannot be confused", async function () {
      const calls = stubFetch({ code: "0000", data: { items: [] } });
      await cv.queryApassList({ customerId: "REBINDALICE001" });

      expect(calls[0].body).to.have.property("customerId", "REBINDALICE001");
      expect(calls[0].body).to.not.have.property("data");
    });

    it("explains a 403 as an encryption fault rather than an auth failure", async function () {
      stubFetch({}, { status: 403 });
      let err;
      try { await cv.queryApass({ address: "0x" + "b".repeat(40) }); }
      catch (e) { err = e; }

      expect(err).to.exist;
      expect(err.message).to.match(/encryption/i);
    });
  });

  describe("Cleanverse — address handling", function () {
    it("lowercases addresses, because checksum casing can return CV_500", async function () {
      const mixed = ethers.getAddress("0x" + "ab".repeat(20)); // checksummed
      const calls = stubFetch({ code: "0000", data: {} });
      await cv.queryApass({ address: mixed });

      expect(calls[0].body.address).to.equal(mixed.toLowerCase());
      expect(calls[0].body.address).to.not.equal(mixed);
    });

    it("rejects malformed addresses at the boundary instead of sending them", function () {
      expect(() => cv.normaliseAddress("not-an-address")).to.throw(/Invalid wallet address/);
      expect(() => cv.normaliseAddress("0x1234")).to.throw(/Invalid wallet address/);
      expect(() => cv.normaliseAddress(null)).to.throw(/Invalid wallet address/);
    });
  });

  describe("Cleanverse — verify_apass verdicts", function () {
    // Everything returns HTTP 200. Branching on response.ok is always wrong.

    it("allows a transfer on the documented success code 4", async function () {
      stubFetch({ code: "0000", data: { code: 4 } });
      const v = await cv.verifyApass({ address: "0x" + "c".repeat(40), atoken: "0x" + "d".repeat(40) });

      expect(v.allowed).to.equal(true);
      expect(v.code).to.equal(4);
    });

    it("refuses, with a reason, when the wallet has no A-Pass", async function () {
      stubFetch({ code: "0000", data: { code: 2, magickLink: "https://example.invalid/kyc" } });
      const v = await cv.verifyApass({ address: "0x" + "c".repeat(40), atoken: "0x" + "d".repeat(40) });

      expect(v.allowed).to.equal(false);
      expect(v.reason).to.match(/no A-Pass/i);
      expect(v.magickLink).to.equal("https://example.invalid/kyc");
    });

    it("THE UNDOCUMENTED SHAPE: a frozen pass returns outer 0002, not data.code 3", async function () {
      // Verified against the live sandbox. There is no data.code field at all,
      // so any handler that reads res.data.code first will null-crash on stage.
      stubFetch({ code: "0002", message: "execution reverted: APassNotActive" });
      const v = await cv.verifyApass({ address: "0x" + "c".repeat(40), atoken: "0x" + "d".repeat(40) });

      expect(v.allowed).to.equal(false);
      expect(v.code).to.equal(3, "frozen must normalise to the documented code 3");
      expect(v.reason).to.match(/frozen/i);
    });

    it("fails closed on a response shape it does not recognise", async function () {
      stubFetch({ code: "9999", message: "something new" });
      const v = await cv.verifyApass({ address: "0x" + "c".repeat(40), atoken: "0x" + "d".repeat(40) });

      expect(v.allowed).to.equal(false);
    });
  });

  describe("Cleanverse — wallet equivalence lookup", function () {
    it("returns every wallet for a customerId, lowercased for comparison", async function () {
      stubFetch({ code: "0000", data: { items: [
        { walletAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
        { walletAddress: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" },
      ] } });

      expect(await cv.walletsForCustomer("REBINDALICE001")).to.deep.equal([
        "0x" + "a".repeat(40), "0x" + "b".repeat(40),
      ]);
    });

    it("returns an empty list rather than throwing when the person is unknown", async function () {
      stubFetch({ code: "0000", data: {} });
      expect(await cv.walletsForCustomer("NOSUCHPERSON00")).to.deep.equal([]);
    });
  });

  describe("Attestor — identity commitment", function () {
    it("is stable for one customerId and distinct across customerIds", function () {
      expect(personIdOf("REBINDALICE001")).to.equal(personIdOf("REBINDALICE001"));
      expect(personIdOf("REBINDALICE001")).to.not.equal(personIdOf("REBINDALICE002"));
    });

    it("is NOT a plain hash of the customerId, which would be guessable", function () {
      // customerIds are institutional and predictable. A bare keccak256 of one
      // is brute-forceable, so the commitment must be salted.
      expect(personIdOf("REBINDALICE001"))
        .to.not.equal(ethers.keccak256(ethers.toUtf8Bytes("REBINDALICE001")));
    });

    it("changes completely if the salt changes, proving the salt is load-bearing", function () {
      const before = personIdOf("REBINDALICE001");
      const original = process.env.IDENTITY_COMMITMENT_SALT;
      process.env.IDENTITY_COMMITMENT_SALT = "a-different-salt";
      const after = personIdOf("REBINDALICE001");
      process.env.IDENTITY_COMMITMENT_SALT = original;

      expect(after).to.not.equal(before);
    });

    it("refuses to derive a commitment when no salt is configured", function () {
      const original = process.env.IDENTITY_COMMITMENT_SALT;
      delete process.env.IDENTITY_COMMITMENT_SALT;
      expect(() => personIdOf("REBINDALICE001")).to.throw(/IDENTITY_COMMITMENT_SALT/);
      process.env.IDENTITY_COMMITMENT_SALT = original;
    });

    it("produces a well-formed bytes32", function () {
      expect(personIdOf("REBINDALICE001")).to.match(/^0x[0-9a-f]{64}$/);
    });
  });

  describe("Attestor — signing", function () {
    const QUEUE = "0x" + "e".repeat(40);
    const OLD = "0x" + "11".repeat(20);
    const NEW = "0x" + "22".repeat(20);
    const STRANGER = "0x" + "33".repeat(20);

    let attestor, wallet, realLookup;

    beforeEach(function () {
      wallet = ethers.Wallet.createRandom();
      attestor = new Attestor({ privateKey: wallet.privateKey, queueAddress: QUEUE, chainId: 84532 });
      realLookup = cv.walletsForCustomer;
    });
    afterEach(function () { cv.walletsForCustomer = realLookup; });

    const bind = (...wallets) => { cv.walletsForCustomer = async () => wallets.map((w) => w.toLowerCase()); };

    it("signs when Cleanverse confirms both wallets share one customerId", async function () {
      bind(OLD, NEW);
      const att = await attestor.signClaim({
        customerId: "REBINDALICE001", oldWallet: OLD, newWallet: NEW, nonce: 0,
      });

      expect(att.proof.equivalent).to.equal(true);
      expect(att.signature).to.match(/^0x[0-9a-f]{130}$/);
    });

    it("THE ATTACK: refuses when the new wallet belongs to someone else", async function () {
      // A stolen wallet is not a stolen identity. This is the refusal that
      // makes the whole product safe, and it must happen before any signing.
      bind(OLD);
      let err;
      try {
        await attestor.signClaim({
          customerId: "REBINDALICE001", oldWallet: OLD, newWallet: STRANGER, nonce: 0,
        });
      } catch (e) { err = e; }

      expect(err, "signClaim must throw").to.exist;
      expect(err.message).to.match(/Refusing to attest/);
      expect(err.proof.equivalent).to.equal(false);
    });

    it("refuses when the OLD wallet is not bound to the claimed customerId", async function () {
      bind(NEW);
      let err;
      try {
        await attestor.signClaim({
          customerId: "REBINDALICE001", oldWallet: OLD, newWallet: NEW, nonce: 0,
        });
      } catch (e) { err = e; }

      expect(err).to.exist;
      expect(err.proof.detail).to.match(/Old wallet/i);
    });

    it("refuses when the person has no wallets at all", async function () {
      bind();
      let err;
      try {
        await attestor.signClaim({
          customerId: "NOSUCHPERSON00", oldWallet: OLD, newWallet: NEW, nonce: 0,
        });
      } catch (e) { err = e; }

      expect(err).to.exist;
    });

    it("compares case-insensitively, so checksummed input still matches", async function () {
      const checksummed = ethers.getAddress(NEW);
      bind(OLD, NEW);
      const att = await attestor.signClaim({
        customerId: "REBINDALICE001", oldWallet: OLD, newWallet: checksummed, nonce: 0,
      });

      expect(att.proof.equivalent).to.equal(true);
    });

    it("produces a signature that recovers to the attestor under the queue's domain", async function () {
      bind(OLD, NEW);
      const att = await attestor.signClaim({
        customerId: "REBINDALICE001", oldWallet: OLD, newWallet: NEW, nonce: 7,
      });

      const recovered = ethers.verifyTypedData(
        { name: "Rebind", version: "1", chainId: 84532, verifyingContract: QUEUE },
        EIP712_TYPES,
        { personId: att.personId, oldWallet: OLD, newWallet: NEW, nonce: 7, deadline: att.deadline },
        att.signature
      );

      expect(recovered).to.equal(wallet.address);
    });

    it("binds the signature to this chain, so a testnet signature cannot be replayed", async function () {
      bind(OLD, NEW);
      const att = await attestor.signClaim({
        customerId: "REBINDALICE001", oldWallet: OLD, newWallet: NEW, nonce: 0,
      });

      // Same message, mainnet domain: the recovered address must be garbage.
      const recovered = ethers.verifyTypedData(
        { name: "Rebind", version: "1", chainId: 8453, verifyingContract: QUEUE },
        EIP712_TYPES,
        { personId: att.personId, oldWallet: OLD, newWallet: NEW, nonce: 0, deadline: att.deadline },
        att.signature
      );

      expect(recovered).to.not.equal(wallet.address);
    });

    it("carries the nonce through unaltered, so the queue can reject a replay", async function () {
      bind(OLD, NEW);
      const a = await attestor.signClaim({ customerId: "REBINDALICE001", oldWallet: OLD, newWallet: NEW, nonce: 0 });
      const b = await attestor.signClaim({ customerId: "REBINDALICE001", oldWallet: OLD, newWallet: NEW, nonce: 1 });

      expect(a.nonce).to.equal(0);
      expect(b.nonce).to.equal(1);
      expect(a.signature).to.not.equal(b.signature);
    });

    it("sets a future deadline so an attestation cannot be held indefinitely", async function () {
      bind(OLD, NEW);
      const now = Math.floor(Date.now() / 1000);
      const att = await attestor.signClaim({
        customerId: "REBINDALICE001", oldWallet: OLD, newWallet: NEW, nonce: 0, ttlSeconds: 600,
      });

      expect(att.deadline).to.be.greaterThan(now);
      expect(att.deadline).to.be.at.most(now + 601);
    });
  });
});
