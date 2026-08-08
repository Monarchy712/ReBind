/**
 * Tests for the local Cleanverse stub (DEMO_MODE=local).
 *
 * The stub's only job is to be SHAPE-COMPATIBLE with backend/cleanverse.js, so
 * code written against the local demo keeps working against the live sandbox.
 * These tests pin the shapes the real callers actually destructure — anything
 * server.js or attestor.js reads off a response is asserted here.
 *
 * Fully offline. The stub makes no network calls by construction.
 */
const { expect } = require("chai");

const local = require("../backend/cleanverse-local");
const real = require("../backend/cleanverse");

const A = "0xa34118bD1A2A789A962A4471C59c3964fb716123";
const B = "0x7A0A94615094Ef0673f2D0F031D43fB9ED78cc0B";
const X = "0x6d11172f538b60BE3a69c745944767Ac94019df7";
const ATOKEN = "0x" + "d".repeat(40);
const CID = "LOCALTEST001";

describe("Cleanverse local stub", function () {
  beforeEach(() => local._reset());

  describe("surface parity with the real client", function () {
    it("exports every function the real client does", function () {
      for (const key of Object.keys(real)) {
        expect(local, `missing export: ${key}`).to.have.property(key);
        expect(typeof local[key], `type mismatch: ${key}`).to.equal(typeof real[key]);
      }
    });

    it("rejects malformed addresses exactly like the real client", function () {
      expect(() => local.normaliseAddress("not-an-address")).to.throw(/Invalid wallet address/);
      expect(() => local.normaliseAddress("0x1234")).to.throw(/Invalid wallet address/);
      expect(() => local.normaliseAddress(null)).to.throw(/Invalid wallet address/);
    });

    it("refuses to make HTTP calls, so a missed stub cannot reach the network", async function () {
      try {
        await local.call("/anything", {});
        expect.fail("expected call() to throw");
      } catch (e) {
        expect(e.message).to.match(/no HTTP calls/i);
      }
    });
  });

  describe("A-Pass binding", function () {
    it("returns the cvRecordId the demo UI displays", async function () {
      const res = await local.generateApass({ customerId: CID, address: A });
      expect(String(res.code)).to.equal("0000");
      expect(res.data.cvRecordId).to.be.a("string");
    });

    it("lowercases stored addresses, matching the real API boundary", async function () {
      await local.generateApass({ customerId: CID, address: A });
      expect(await local.walletsForCustomer(CID)).to.deep.equal([A.toLowerCase()]);
    });

    it("binds two wallets to ONE customerId — the fact recovery depends on", async function () {
      await local.generateApass({ customerId: CID, address: A });
      await local.generateApass({ customerId: CID, address: B, override: true });

      expect(await local.walletsForCustomer(CID)).to.have.members([
        A.toLowerCase(), B.toLowerCase(),
      ]);
    });

    it("keeps separate customers separate", async function () {
      await local.generateApass({ customerId: CID, address: A });
      await local.generateApass({ customerId: "SOMEONEELSE", address: X });

      expect(await local.walletsForCustomer(CID)).to.deep.equal([A.toLowerCase()]);
    });

    it("returns an empty list for an unknown customer rather than throwing", async function () {
      expect(await local.walletsForCustomer("NOBODY")).to.deep.equal([]);
    });
  });

  describe("verifyApass — the compliance gate", function () {
    it("allows a wallet with an active A-Pass (code 4)", async function () {
      await local.generateApass({ customerId: CID, address: A });
      const v = await local.verifyApass({ address: A, atoken: ATOKEN });

      expect(v.allowed).to.equal(true);
      expect(v.code).to.equal(4);
    });

    it("refuses an unverified wallet with code 2 — the blocked-theft beat", async function () {
      const v = await local.verifyApass({ address: X, atoken: ATOKEN });

      expect(v.allowed).to.equal(false);
      expect(v.code).to.equal(2);
      expect(v.reason).to.equal("Wallet has no A-Pass");
    });

    it("refuses a frozen A-Pass with code 3", async function () {
      await local.generateApass({ customerId: CID, address: A });
      await local.updateStatus({ customerId: CID, address: A, status: 2 });
      const v = await local.verifyApass({ address: A, atoken: ATOKEN });

      expect(v.allowed).to.equal(false);
      expect(v.code).to.equal(3);
    });

    it("refuses an expired A-Pass with code 3", async function () {
      await local.generateApass({ customerId: CID, address: A, expirationTime: 1 });
      const v = await local.verifyApass({ address: A, atoken: ATOKEN });

      expect(v.code).to.equal(3);
    });

    it("reports a missing A-Token as code 1", async function () {
      await local.generateApass({ customerId: CID, address: A });
      const v = await local.verifyApass({ address: A, atoken: null });

      expect(v.code).to.equal(1);
    });

    it("unfreezing restores the pass, so a cancelled claim is recoverable", async function () {
      await local.generateApass({ customerId: CID, address: A });
      await local.updateStatus({ customerId: CID, address: A, status: 2 });
      await local.updateStatus({ customerId: CID, address: A, status: 1 });

      expect((await local.verifyApass({ address: A, atoken: ATOKEN })).allowed).to.equal(true);
    });
  });

  describe("query endpoints", function () {
    it("queryApass omits customerId, mirroring the documented real behaviour", async function () {
      await local.generateApass({ customerId: CID, address: A });
      const res = await local.queryApass({ address: A });

      expect(String(res.code)).to.equal("0000");
      expect(res.data).to.not.have.property("customerId");
    });

    it("queryApassList paginates", async function () {
      await local.generateApass({ customerId: CID, address: A });
      await local.generateApass({ customerId: CID, address: B, override: true });

      const page = await local.queryApassList({ customerId: CID, page: 1, pageSize: 1 });
      expect(page.data.total).to.equal(2);
      expect(page.data.items).to.have.length(1);
    });
  });
});
