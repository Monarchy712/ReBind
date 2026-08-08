/**
 * Bridge advance: borrowing against a recovery claim mid-cure-window.
 *
 * The properties worth pinning here are economic, not just functional. In
 * order of how much they would cost if they broke:
 *
 *   1. The vault can only lend against a claim that CANNOT be cancelled.
 *   2. Repayment cannot be skipped, because it happens inside execution.
 *   3. A shortfall costs the vault, never the recovering owner.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");

const CURE = 60;
const NOTE_DEC = 6;
const STABLE_DEC = 6;
const LTV_BPS = 8000;
const FEE_BPS = 50;

const note = (n) => ethers.parseUnits(String(n), NOTE_DEC);
const usd = (n) => ethers.parseUnits(String(n), STABLE_DEC);

async function signClaim(attestor, queueAddr, chainId, { personId, oldWallet, newWallet, nonce, deadline }) {
  return attestor.signTypedData(
    { name: "Rebind", version: "1", chainId, verifyingContract: queueAddr },
    {
      RecoveryClaim: [
        { name: "personId", type: "bytes32" },
        { name: "oldWallet", type: "address" },
        { name: "newWallet", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    { personId, oldWallet, newWallet, nonce, deadline }
  );
}

describe("Bridge advance", function () {
  let admin, attestor, issuer, alice, aliceNew, outsider;
  let registry, token, queue, executor, vault, stable, oracle;
  let ALICE_ID, VAULT_ID, chainId;

  const openClaim = async () => {
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    const sig = await signClaim(attestor, await queue.getAddress(), chainId, {
      personId: ALICE_ID,
      oldWallet: alice.address,
      newWallet: aliceNew.address,
      nonce: Number(await queue.nonces(aliceNew.address)),
      deadline,
    });
    await queue.openClaim(ALICE_ID, alice.address, aliceNew.address, deadline, sig);
    return Number(await queue.claimCount()) - 1;
  };

  const elapseWindow = async () => {
    await ethers.provider.send("evm_increaseTime", [CURE + 1]);
    await ethers.provider.send("evm_mine", []);
  };

  beforeEach(async function () {
    [admin, attestor, issuer, alice, aliceNew, outsider] = await ethers.getSigners();
    chainId = Number((await ethers.provider.getNetwork()).chainId);

    ALICE_ID = ethers.keccak256(ethers.toUtf8Bytes("ALICECUST0001"));
    VAULT_ID = ethers.keccak256(ethers.toUtf8Bytes("REBIND_BRIDGE_VAULT_INSTITUTION"));

    registry = await (await ethers.getContractFactory("BindingRegistry"))
      .deploy(admin.address, attestor.address);
    token = await (await ethers.getContractFactory("RebindableRWA"))
      .deploy("Series A Note", "NOTE", NOTE_DEC, await registry.getAddress(), admin.address);
    queue = await (await ethers.getContractFactory("RecoveryQueue"))
      .deploy(await registry.getAddress(), attestor.address, admin.address, CURE);
    stable = await (await ethers.getContractFactory("DemoStablecoin"))
      .deploy("Demo USD", "dUSDC", STABLE_DEC, admin.address);
    oracle = await (await ethers.getContractFactory("ParAdvanceOracle"))
      .deploy(NOTE_DEC, STABLE_DEC);

    vault = await (await ethers.getContractFactory("BridgeAdvanceVault")).deploy(
      await queue.getAddress(),
      await token.getAddress(),
      await stable.getAddress(),
      await oracle.getAddress(),
      admin.address,
      LTV_BPS,
      FEE_BPS
    );

    executor = await (await ethers.getContractFactory("RebindExecutor")).deploy(
      await queue.getAddress(),
      await token.getAddress(),
      await registry.getAddress(),
      await vault.getAddress()
    );

    await token.connect(admin).setExecutor(await executor.getAddress());
    await queue.connect(admin).setExecutor(await executor.getAddress());
    await queue.connect(admin).grantRole(await queue.ISSUER_ROLE(), issuer.address);
    await registry.connect(admin).grantRole(await registry.RECOVERY_ROLE(), await queue.getAddress());
    await vault.connect(admin).setExecutor(await executor.getAddress());

    await registry.connect(attestor).bindWallet(ALICE_ID, alice.address);
    await registry.connect(attestor).bindWallet(ALICE_ID, aliceNew.address);
    // The vault must itself be a bound wallet or the restricted note will not
    // let it receive repayment.
    await registry.connect(attestor).bindWallet(VAULT_ID, await vault.getAddress());

    await token.connect(admin).mint(alice.address, note(5000));

    await stable.connect(admin).mint(admin.address, usd(100000));
    await stable.connect(admin).approve(await vault.getAddress(), usd(100000));
    await vault.connect(admin).depositLiquidity(usd(100000));
  });

  // ------------------------------------------------------- the core property

  describe("only lends against claims that cannot be cancelled", function () {
    it("refuses an open claim that has not been approved", async function () {
      const id = await openClaim();
      await expect(vault.connect(aliceNew).draw(id))
        .to.be.revertedWithCustomError(vault, "ClaimNotCommitted");
    });

    it("THE POINT: refuses a claim that is merely APPROVED", async function () {
      const id = await openClaim();
      await queue.connect(issuer).approve(id);

      // Approval is revocable, so it is not collateral. Lending here is exactly
      // the hole that would let an issuer approve, watch the vault disburse,
      // then cancel and walk away with the vault's money.
      await expect(vault.connect(aliceNew).draw(id))
        .to.be.revertedWithCustomError(vault, "ClaimNotCommitted");
    });

    it("lends against a committed claim", async function () {
      const id = await openClaim();
      await queue.connect(issuer).commit(id);

      await expect(vault.connect(aliceNew).draw(id))
        .to.emit(vault, "AdvanceDrawn");
    });

    it("commit() makes cancel() permanently impossible", async function () {
      const id = await openClaim();
      await queue.connect(issuer).commit(id);

      await expect(queue.connect(issuer).cancel(id))
        .to.be.revertedWithCustomError(queue, "ClaimIsCommitted");
    });

    it("commit() implies approval, so the claim really will settle", async function () {
      const id = await openClaim();
      await queue.connect(issuer).commit(id);

      expect((await queue.getClaim(id)).issuerApproved).to.equal(true);
      await elapseWindow();
      expect(await queue.isExecutable(id)).to.equal(true);
    });

    it("only an issuer may commit", async function () {
      const id = await openClaim();
      await expect(queue.connect(outsider).commit(id)).to.be.reverted;
    });

    it("a cancelled claim can never be committed afterwards", async function () {
      const id = await openClaim();
      await queue.connect(issuer).cancel(id);
      await expect(queue.connect(issuer).commit(id))
        .to.be.revertedWithCustomError(queue, "ClaimClosed");
    });
  });

  // ------------------------------------------------------------- borrowing

  describe("drawing", function () {
    let id;
    beforeEach(async function () {
      id = await openClaim();
      await queue.connect(issuer).commit(id);
    });

    it("advances LTV against the claim's value", async function () {
      const [principal] = await vault.quote(id);
      expect(principal).to.equal(usd(4000)); // 80% of 5,000 at par

      await vault.connect(aliceNew).draw(id);
      expect(await stable.balanceOf(aliceNew.address)).to.equal(usd(4000));
    });

    it("owes principal plus fee, denominated in the note", async function () {
      const [, dueNote] = await vault.quote(id);
      expect(dueNote).to.equal(note(4020)); // 4,000 + 0.5%
    });

    it("pays out to the new wallet, not to the frozen one", async function () {
      await vault.connect(aliceNew).draw(id);
      expect(await stable.balanceOf(alice.address)).to.equal(0);
    });

    it("only the claim's new wallet may borrow", async function () {
      await expect(vault.connect(outsider).draw(id))
        .to.be.revertedWithCustomError(vault, "NotBorrower");
      await expect(vault.connect(alice).draw(id))
        .to.be.revertedWithCustomError(vault, "NotBorrower");
    });

    it("cannot be drawn twice", async function () {
      await vault.connect(aliceNew).draw(id);
      await expect(vault.connect(aliceNew).draw(id))
        .to.be.revertedWithCustomError(vault, "AlreadyDrawn");
    });

    it("refuses when the vault is out of liquidity", async function () {
      await vault.connect(admin).withdrawLiquidity(admin.address, usd(100000));
      await expect(vault.connect(aliceNew).draw(id))
        .to.be.revertedWithCustomError(vault, "InsufficientLiquidity");
    });

    it("tracks outstanding principal", async function () {
      await vault.connect(aliceNew).draw(id);
      expect(await vault.totalPrincipalOutstanding()).to.equal(usd(4000));
    });

    it("quote() returns zero for an ineligible claim instead of reverting", async function () {
      const fresh = await openClaim();
      const [principal, due] = await vault.quote(fresh);
      expect(principal).to.equal(0);
      expect(due).to.equal(0);
    });
  });

  // ------------------------------------------------------------- settlement

  describe("settlement", function () {
    let id;
    beforeEach(async function () {
      id = await openClaim();
      await queue.connect(issuer).commit(id);
      await vault.connect(aliceNew).draw(id);
      await elapseWindow();
    });

    it("THE POINT: repayment is taken during execution, not asked for", async function () {
      await executor.execute(id);

      expect(await token.balanceOf(await vault.getAddress())).to.equal(note(4020));
      expect(await token.balanceOf(aliceNew.address)).to.equal(note(980));
      expect(await token.balanceOf(alice.address)).to.equal(0);
    });

    it("the borrower nets the claim minus what was borrowed", async function () {
      await executor.execute(id);

      // Drew $4,000, kept 980 NOTE, so 4,980 of 5,000 of value — the 20 NOTE
      // gap is the origination fee.
      expect(await stable.balanceOf(aliceNew.address)).to.equal(usd(4000));
      expect(await token.balanceOf(aliceNew.address)).to.equal(note(980));
    });

    it("marks the advance repaid and clears outstanding principal", async function () {
      await executor.execute(id);

      expect((await vault.getAdvance(id)).repaid).to.equal(true);
      expect(await vault.hasOutstandingAdvance(id)).to.equal(false);
      expect(await vault.totalPrincipalOutstanding()).to.equal(0);
    });

    it("stops asking for repayment once settled", async function () {
      await executor.execute(id);
      expect(await vault.repaymentDue(id)).to.equal(0);
    });

    it("previewSplit reports the split before it happens", async function () {
      const [total, toVault, toWallet] = await executor.previewSplit(id);
      expect(total).to.equal(note(5000));
      expect(toVault).to.equal(note(4020));
      expect(toWallet).to.equal(note(980));
    });

    it("only the executor may settle", async function () {
      await expect(vault.connect(admin).settle(id, note(4020)))
        .to.be.revertedWithCustomError(vault, "OnlyExecutor");
      await expect(vault.connect(aliceNew).settle(id, note(4020)))
        .to.be.revertedWithCustomError(vault, "OnlyExecutor");
    });
  });

  // ------------------------------------------------------------- shortfalls

  describe("when the claim is worth less than was borrowed", function () {
    it("the vault absorbs the shortfall and the recovery still completes", async function () {
      const id = await openClaim();
      await queue.connect(issuer).commit(id);
      await vault.connect(aliceNew).draw(id); // owed 4,020 NOTE

      // The issuer burns most of the frozen balance — a redemption, say.
      await token.connect(admin).burn(alice.address, note(4500));
      await elapseWindow();

      await executor.execute(id);

      // Everything that existed went to the vault; the owner got nothing, but
      // critically the recovery did not revert and leave the asset stranded.
      expect(await token.balanceOf(await vault.getAddress())).to.equal(note(500));
      expect(await token.balanceOf(aliceNew.address)).to.equal(0);
      expect((await vault.getAdvance(id)).repaid).to.equal(true);
    });

    it("reports the shortfall so the loss is visible on-chain", async function () {
      const id = await openClaim();
      await queue.connect(issuer).commit(id);
      await vault.connect(aliceNew).draw(id);
      await token.connect(admin).burn(alice.address, note(4500));
      await elapseWindow();

      await expect(executor.execute(id))
        .to.emit(vault, "AdvanceRepaid")
        .withArgs(id, note(500), note(3520));
    });
  });

  // ------------------------------------------------- no vault / no advance

  describe("claims without an advance", function () {
    it("settles the whole balance to the owner", async function () {
      const id = await openClaim();
      await queue.connect(issuer).approve(id);
      await elapseWindow();

      await executor.execute(id);
      expect(await token.balanceOf(aliceNew.address)).to.equal(note(5000));
      expect(await token.balanceOf(await vault.getAddress())).to.equal(0);
    });

    it("an uncommitted claim is still cancellable, and cancelling still works", async function () {
      const id = await openClaim();
      await queue.connect(issuer).cancel(id);

      expect((await queue.getClaim(id)).cancelled).to.equal(true);
      expect(await registry.isActive(alice.address)).to.equal(true);
    });
  });

  // ------------------------------------------------------------ vault admin

  describe("vault administration", function () {
    it("refuses nonsense terms", async function () {
      await expect(vault.connect(admin).setTerms(0, FEE_BPS))
        .to.be.revertedWithCustomError(vault, "BadTerms");
      await expect(vault.connect(admin).setTerms(10001, FEE_BPS))
        .to.be.revertedWithCustomError(vault, "BadTerms");
    });

    it("new terms do not change advances already drawn", async function () {
      const id = await openClaim();
      await queue.connect(issuer).commit(id);
      await vault.connect(aliceNew).draw(id);

      await vault.connect(admin).setTerms(5000, 1000);
      expect(await vault.repaymentDue(id)).to.equal(note(4020));
    });

    it("withdrawLiquidity cannot touch repaid notes", async function () {
      const id = await openClaim();
      await queue.connect(issuer).commit(id);
      await vault.connect(aliceNew).draw(id);
      await elapseWindow();
      await executor.execute(id);

      // Vault holds 4,020 NOTE plus 96,000 dUSDC. Only the stable is withdrawable.
      await expect(vault.connect(admin).withdrawLiquidity(admin.address, usd(96001)))
        .to.be.revertedWithCustomError(vault, "InsufficientLiquidity");
      await vault.connect(admin).withdrawLiquidity(admin.address, usd(96000));
      expect(await token.balanceOf(await vault.getAddress())).to.equal(note(4020));
    });

    it("only the treasury may move liquidity", async function () {
      await expect(vault.connect(outsider).withdrawLiquidity(outsider.address, usd(1)))
        .to.be.reverted;
      await expect(vault.connect(outsider).sweepNotes(outsider.address, 0))
        .to.be.reverted;
    });
  });

  // ---------------------------------------------------------------- oracle

  describe("ParAdvanceOracle", function () {
    it("round-trips at par when decimals match", async function () {
      expect(await oracle.noteToStable(note(1234))).to.equal(usd(1234));
      expect(await oracle.stableToNote(usd(1234))).to.equal(note(1234));
    });

    it("scales when the stable has more decimals", async function () {
      const o = await (await ethers.getContractFactory("ParAdvanceOracle")).deploy(6, 18);
      expect(await o.noteToStable(ethers.parseUnits("1", 6))).to.equal(ethers.parseUnits("1", 18));
      expect(await o.stableToNote(ethers.parseUnits("1", 18))).to.equal(ethers.parseUnits("1", 6));
    });

    it("rejects absurd decimals rather than overflowing later", async function () {
      const f = await ethers.getContractFactory("ParAdvanceOracle");
      await expect(f.deploy(77, 6)).to.be.revertedWithCustomError(f, "DecimalsTooLarge");
    });
  });
});
