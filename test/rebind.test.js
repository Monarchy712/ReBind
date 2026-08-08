const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const CURE = 600; // 10 minutes
const ONE = 1_000_000n; // 1 token at 6 decimals

/** Build and sign the EIP-712 RecoveryClaim attestation. */
async function attest(queue, attestor, { personId, oldWallet, newWallet, nonce, deadline }) {
  const net = await ethers.provider.getNetwork();
  const domain = {
    name: "Rebind",
    version: "1",
    chainId: net.chainId,
    verifyingContract: await queue.getAddress(),
  };
  const types = {
    RecoveryClaim: [
      { name: "personId", type: "bytes32" },
      { name: "oldWallet", type: "address" },
      { name: "newWallet", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  return attestor.signTypedData(domain, types, {
    personId, oldWallet, newWallet, nonce, deadline,
  });
}

/** Build and sign the EIP-712 RecoveryClaim co-signature with the guardian's key. */
async function signGuardian(queue, guardian, { personId, oldWallet, newWallet, nonce, deadline }) {
  const net = await ethers.provider.getNetwork();
  const domain = {
    name: "Rebind",
    version: "1",
    chainId: net.chainId,
    verifyingContract: await queue.getAddress(),
  };
  const types = {
    RecoveryClaim: [
      { name: "personId", type: "bytes32" },
      { name: "oldWallet", type: "address" },
      { name: "newWallet", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  return guardian.signTypedData(domain, types, {
    personId, oldWallet, newWallet, nonce, deadline,
  });
}

describe("Rebind", function () {
  let admin, attestor, issuer, alice, aliceNew, bob, attacker, guardianAlice, guardianBob, aliceOther; // added aliceOther
  let registry, token, queue, executor;
  let ALICE_ID, BOB_ID;

  beforeEach(async function () {
    [admin, attestor, issuer, alice, aliceNew, bob, attacker, aliceOther, guardianAlice, guardianBob] = await ethers.getSigners(); // added aliceOther

    ALICE_ID = ethers.keccak256(ethers.toUtf8Bytes("ALICECUST0001"));
    BOB_ID = ethers.keccak256(ethers.toUtf8Bytes("BOBCUST000001"));

    registry = await (await ethers.getContractFactory("BindingRegistry"))
      .deploy(admin.address, attestor.address);

    token = await (await ethers.getContractFactory("RebindableRWA"))
      .deploy("Series A Note", "NOTE", 6, await registry.getAddress(), admin.address);

    queue = await (await ethers.getContractFactory("RecoveryQueue"))
      .deploy(await registry.getAddress(), attestor.address, admin.address, CURE);

    // No vault: these tests cover recovery on its own, and address(0) is the
    // supported "bridge advances disabled" configuration.
    executor = await (await ethers.getContractFactory("RebindExecutor"))
      .deploy(
        await queue.getAddress(), await token.getAddress(), await registry.getAddress(),
        ethers.ZeroAddress
      );

    await token.connect(admin).setExecutor(await executor.getAddress());
    await queue.connect(admin).setExecutor(await executor.getAddress());
    await queue.connect(admin).grantRole(await queue.ISSUER_ROLE(), issuer.address);
    await registry.connect(admin).grantRole(await registry.RECOVERY_ROLE(), await queue.getAddress());

    // Alice holds two wallets under one identity with guardianAlice. Bob holds one with guardianBob.
    await registry.connect(attestor).bindWallet(ALICE_ID, alice.address, guardianAlice.address);
    await registry.connect(attestor).bindWallet(ALICE_ID, aliceNew.address, guardianAlice.address);
    await registry.connect(attestor).bindWallet(BOB_ID, bob.address, guardianBob.address);
  });

  // ------------------------------------------------------------- registry

  describe("BindingRegistry", function () {
    it("links two wallets to one person", async function () {
      expect(await registry.samePerson(alice.address, aliceNew.address)).to.equal(true);
      expect(await registry.samePerson(alice.address, bob.address)).to.equal(false);
    });

    it("treats an unbound wallet as nobody, not as a match", async function () {
      expect(await registry.samePerson(attacker.address, attacker.address)).to.equal(false);
    });

    it("registering a wallet WITHOUT a guardian address reverts with MissingGuardian", async function () {
      const freshCust = ethers.keccak256(ethers.toUtf8Bytes("FRESHCUST123"));
      await expect(
        registry.connect(attestor).bindWallet(freshCust, attacker.address, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(registry, "MissingGuardian");
    });

    it("registering WITH a valid guardian succeeds and guardianOf is correctly stored", async function () {
      expect(await registry.guardianOf(ALICE_ID)).to.equal(guardianAlice.address);
      expect(await registry.guardianOf(BOB_ID)).to.equal(guardianBob.address);
    });

    it("refuses to rebind a wallet to a second person", async function () {
      await expect(registry.connect(attestor).bindWallet(BOB_ID, alice.address, guardianBob.address))
        .to.be.revertedWithCustomError(registry, "AlreadyBound");
    });

    it("only the attestor may write bindings", async function () {
      await expect(registry.connect(attacker).bindWallet(ALICE_ID, attacker.address, guardianAlice.address))
        .to.be.reverted;
    });

    it("revocation flips isActive but preserves the person link", async function () {
      await registry.connect(attestor).revokeWallet(alice.address, "key compromised");
      expect(await registry.isActive(alice.address)).to.equal(false);
      expect(await registry.samePerson(alice.address, aliceNew.address)).to.equal(true);
    });
  });

  // ---------------------------------------------------------------- gate

  describe("Transfer gate", function () {
    it("mints to a verified wallet", async function () {
      await token.connect(admin).mint(alice.address, 100n * ONE);
      expect(await token.balanceOf(alice.address)).to.equal(100n * ONE);
    });

    it("refuses to mint to an unverified wallet", async function () {
      await expect(token.connect(admin).mint(attacker.address, ONE))
        .to.be.revertedWithCustomError(token, "RecipientNotEligible");
    });

    it("allows a transfer between two verified wallets", async function () {
      await token.connect(admin).mint(alice.address, 100n * ONE);
      await token.connect(alice).transfer(bob.address, 10n * ONE);
      expect(await token.balanceOf(bob.address)).to.equal(10n * ONE);
    });

    it("BLOCKS a transfer to an unverified attacker", async function () {
      await token.connect(admin).mint(alice.address, 100n * ONE);
      await expect(token.connect(alice).transfer(attacker.address, ONE))
        .to.be.revertedWithCustomError(token, "RecipientNotEligible");
    });

    it("blocks transferFrom too — the gate cannot be bypassed via approve", async function () {
      await token.connect(admin).mint(alice.address, 100n * ONE);
      await token.connect(alice).approve(attacker.address, 100n * ONE);
      await expect(
        token.connect(attacker).transferFrom(alice.address, attacker.address, ONE)
      ).to.be.revertedWithCustomError(token, "RecipientNotEligible");
    });

    it("blocks a revoked sender", async function () {
      await token.connect(admin).mint(alice.address, 100n * ONE);
      await registry.connect(attestor).revokeWallet(alice.address, "frozen");
      await expect(token.connect(alice).transfer(bob.address, ONE))
        .to.be.revertedWithCustomError(token, "SenderBindingRevoked");
    });

    it("blocks a revoked recipient", async function () {
      await token.connect(admin).mint(alice.address, 100n * ONE);
      await registry.connect(attestor).revokeWallet(bob.address, "sanctioned");
      await expect(token.connect(alice).transfer(bob.address, ONE))
        .to.be.revertedWithCustomError(token, "RecipientNotEligible");
    });

    it("explains refusals in human terms (ERC-1404)", async function () {
      const code = await token.detectTransferRestriction(alice.address, attacker.address, 1n);
      expect(code).to.equal(3);
      expect(await token.messageForTransferRestriction(code))
        .to.equal("Recipient has no A-Pass binding");

      // value 0 asks the pure eligibility question, with no balance component.
      const ok = await token.detectTransferRestriction(alice.address, bob.address, 0n);
      expect(ok).to.equal(0);
      expect(await token.messageForTransferRestriction(ok)).to.equal("Transfer allowed");
    });

    it("reports a revoked sender and a revoked recipient distinctly", async function () {
      await registry.connect(attestor).revokeWallet(alice.address, "lost");
      expect(await token.detectTransferRestriction(alice.address, bob.address, 1n)).to.equal(2);

      await registry.connect(attestor).revokeWallet(bob.address, "lost");
      expect(await token.detectTransferRestriction(aliceNew.address, bob.address, 1n)).to.equal(4);
    });

    it("reports an unbound sender", async function () {
      expect(await token.detectTransferRestriction(attacker.address, bob.address, 1n)).to.equal(1);
    });

    it("uses the value argument: flags a balance it could not cover", async function () {
      await token.connect(admin).mint(alice.address, 100n);
      expect(await token.detectTransferRestriction(alice.address, bob.address, 100n)).to.equal(0);
      expect(await token.detectTransferRestriction(alice.address, bob.address, 101n)).to.equal(5);
    });

    it("reports eligibility problems ahead of balance problems", async function () {
      // Both are wrong, but topping up the balance would not fix the transfer.
      // Naming the counterparty is the more useful answer.
      expect(await token.detectTransferRestriction(alice.address, attacker.address, 999n)).to.equal(3);
    });

    it("agrees with the gate: every non-zero code corresponds to a real revert", async function () {
      // A pre-flight check that disagrees with enforcement is worse than none,
      // because callers trust it and lose gas anyway.
      await token.connect(admin).mint(alice.address, 500n);
      const cases = [
        [alice, attacker, 100n],   // recipient unbound
        [attacker, bob, 100n],     // sender unbound
        [alice, bob, 100000n],     // insufficient balance
      ];
      for (const [from, to, value] of cases) {
        const code = await token.detectTransferRestriction(from.address, to.address, value);
        expect(code, "expected a restriction").to.not.equal(0);
        await expect(token.connect(from).transfer(to.address, value)).to.be.reverted;
      }

      // And the converse: a clean code really does go through.
      expect(await token.detectTransferRestriction(alice.address, bob.address, 100n)).to.equal(0);
      await expect(token.connect(alice).transfer(bob.address, 100n)).to.not.be.reverted;
    });

    it("names every code it can return, and admits when it cannot", async function () {
      const expected = [
        "Transfer allowed", "Sender has no A-Pass binding", "Sender binding revoked",
        "Recipient has no A-Pass binding", "Recipient binding revoked", "Insufficient balance",
      ];
      for (let i = 0; i < expected.length; i++) {
        expect(await token.messageForTransferRestriction(i)).to.equal(expected[i]);
      }
      expect(await token.messageForTransferRestriction(99)).to.equal("Unknown restriction code");
    });
  });

  // ------------------------------------------------------------ the queue

  describe("RecoveryQueue", function () {
    let deadline;
    beforeEach(async function () {
      deadline = (await time.latest()) + 3600;
    });

    it("opens a claim with a valid attestation", async function () {
      const sig = await attest(queue, attestor, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });
      const gSig = await signGuardian(queue, guardianAlice, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });
      await expect(queue.openClaim(ALICE_ID, alice.address, aliceNew.address, deadline, sig, gSig))
        .to.emit(queue, "ClaimOpened");
      expect(await queue.claimCount()).to.equal(1n);
      expect(await registry.revoked(alice.address)).to.equal(true);
    });

    it("rejects an attestation signed by anyone but the attestor", async function () {
      const sig = await attest(queue, attacker, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });
      const gSig = await signGuardian(queue, guardianAlice, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });
      await expect(queue.openClaim(ALICE_ID, alice.address, aliceNew.address, deadline, sig, gSig))
        .to.be.revertedWithCustomError(queue, "BadAttestation");
    });

    it("opening a claim with the WRONG guardian's signature reverts with BadGuardianAttestation", async function () {
      const sig = await attest(queue, attestor, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });
      const badGuardianSig = await signGuardian(queue, attacker, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });
      await expect(queue.openClaim(ALICE_ID, alice.address, aliceNew.address, deadline, sig, badGuardianSig))
        .to.be.revertedWithCustomError(queue, "BadGuardianAttestation");
    });

    it("rejects an expired attestation", async function () {
      const past = (await time.latest()) - 1;
      const sig = await attest(queue, attestor, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline: past,
      });
      const gSig = await signGuardian(queue, guardianAlice, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline: past,
      });
      await expect(queue.openClaim(ALICE_ID, alice.address, aliceNew.address, past, sig, gSig))
        .to.be.revertedWithCustomError(queue, "AttestationExpired");
    });

    it("THE ATTACK: refuses a claim across two different people", async function () {
      const sig = await attest(queue, attestor, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: bob.address, nonce: 0, deadline,
      });
      const gSig = await signGuardian(queue, guardianAlice, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: bob.address, nonce: 0, deadline,
      });
      await expect(queue.openClaim(ALICE_ID, alice.address, bob.address, deadline, sig, gSig))
        .to.be.revertedWithCustomError(queue, "NotSamePerson");
    });

    it("refuses to recover into an unverified wallet", async function () {
      await registry.connect(attestor).bindWallet(ALICE_ID, attacker.address, guardianAlice.address);
      await registry.connect(attestor).revokeWallet(attacker.address, "bad");
      const sig = await attest(queue, attestor, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: attacker.address, nonce: 0, deadline,
      });
      const gSig = await signGuardian(queue, guardianAlice, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: attacker.address, nonce: 0, deadline,
      });
      await expect(queue.openClaim(ALICE_ID, alice.address, attacker.address, deadline, sig, gSig))
        .to.be.revertedWithCustomError(queue, "NewWalletNotActive");
    });

        it("REPLAY: the same signature cannot be used twice", async function () {
      const sig = await attest(queue, attestor, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });
      const gSig = await signGuardian(queue, guardianAlice, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });
      await queue.openClaim(ALICE_ID, alice.address, aliceNew.address, deadline, sig, gSig);
      await queue.connect(issuer).cancel(0); // free the active-claim slot so this test isolates nonce replay
      // nonce is now 1, so the old signature no longer verifies
      await expect(queue.openClaim(ALICE_ID, alice.address, aliceNew.address, deadline, sig, gSig))
        .to.be.revertedWithCustomError(queue, "BadAttestation");
    });

    it("freezes the old wallet at claim opening so a stolen key cannot drain it", async function () {
      const sig = await attest(queue, attestor, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });
      const gSig = await signGuardian(queue, guardianAlice, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });
      await queue.openClaim(ALICE_ID, alice.address, aliceNew.address, deadline, sig, gSig);
      await expect(queue.connect(alice).cancel(0)).to.be.reverted;
      await expect(queue.connect(issuer).cancel(0)).to.emit(queue, "ClaimCancelled");
      expect((await queue.getClaim(0)).cancelled).to.equal(true);
      expect(await registry.isActive(alice.address)).to.equal(true);
    });

    it("only an issuer reviewer may cancel", async function () {
      const sig = await attest(queue, attestor, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });
      const gSig = await signGuardian(queue, guardianAlice, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });
      await queue.openClaim(ALICE_ID, alice.address, aliceNew.address, deadline, sig, gSig);
      await expect(queue.connect(attacker).cancel(0)).to.be.reverted;
    });

    it("is not executable before the cure window elapses", async function () {
      const sig = await attest(queue, attestor, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });
      const gSig = await signGuardian(queue, guardianAlice, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });
      await queue.openClaim(ALICE_ID, alice.address, aliceNew.address, deadline, sig, gSig);
      await queue.connect(issuer).approve(0);
      expect(await queue.isExecutable(0)).to.equal(false);
      await time.increase(CURE + 1);
      expect(await queue.isExecutable(0)).to.equal(true);
    });

    it("is not executable without issuer approval", async function () {
      const sig = await attest(queue, attestor, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });
      const gSig = await signGuardian(queue, guardianAlice, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });
      await queue.openClaim(ALICE_ID, alice.address, aliceNew.address, deadline, sig, gSig);
      await time.increase(CURE + 1);
      expect(await queue.isExecutable(0)).to.equal(false);
    });

    it("THE FIX: rejects a claim where oldWallet equals newWallet", async function () {
      const sig = await attest(queue, attestor, {
      personId: ALICE_ID,
      oldWallet: alice.address,
      newWallet: alice.address,
      nonce: 0,
      deadline,
    });

    const gSig = await signGuardian(queue, guardianAlice, {
      personId: ALICE_ID,
      oldWallet: alice.address,
      newWallet: alice.address,
      nonce: 0,
      deadline,
    });

    await expect(
      queue.openClaim(ALICE_ID, alice.address, alice.address, deadline, sig, gSig)
    ).to.be.revertedWithCustomError(queue, "SameWallet").withArgs(alice.address);
    });

    it("never freezes the wallet when the same-wallet claim is rejected", async function () {
      // Before the fix, samePerson(a,a) and isActive(a) both trivially pass,
      // so this would open a claim and freeze the wallet for no recovery benefit.
      const sig = await attest(queue, attestor, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: alice.address, nonce: 0, deadline,
      });

      const gSig = await signGuardian(queue, guardianAlice, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: alice.address, nonce: 0, deadline,
      });

      await expect(queue.openClaim(ALICE_ID, alice.address, alice.address, deadline, sig, gSig))
        .to.be.reverted;
      expect(await registry.revoked(alice.address)).to.equal(false);
      expect(await queue.claimCount()).to.equal(0n);
    });

        it("THE FIX: a second, distinct, honestly-signed claim cannot open against an oldWallet that already has one live", async function () {
      // Alice legitimately controls a third wallet, so this attestation is
      // just as valid as the first one — it's not a forged or replayed signature.
      await registry.connect(attestor).bindWallet(ALICE_ID, aliceOther.address, guardianAlice.address);

      const sigA = await attest(queue, attestor, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });

      const gSigA = await signGuardian(queue, guardianAlice, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });

      await queue.openClaim(ALICE_ID, alice.address, aliceNew.address, deadline, sigA, gSigA);

      const sigB = await attest(queue, attestor, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceOther.address, nonce: 0, deadline,
      });

      const gSigB = await signGuardian(queue, guardianAlice, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceOther.address, nonce: 0, deadline,
      });

      // sigB is a fresh, valid, non-replayed signature — nonce replay
      // protection alone would let this through. The active-claim guard
      // is what actually stops it.
      await expect(queue.openClaim(ALICE_ID, alice.address, aliceOther.address, deadline, sigB, gSigB))
        .to.be.revertedWithCustomError(queue, "ClaimAlreadyActive")
        .withArgs(alice.address, 0n);
    });

    it("does not block a second claim once the first is cancelled", async function () {
      await registry.connect(attestor).bindWallet(ALICE_ID, aliceOther.address, guardianAlice.address);

      const sigA = await attest(queue, attestor, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });

      const gSigA = await signGuardian(queue, guardianAlice, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });

      await queue.openClaim(ALICE_ID, alice.address, aliceNew.address, deadline, sigA, gSigA);
      await queue.connect(issuer).cancel(0);

      const sigB = await attest(queue, attestor, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceOther.address, nonce: 0, deadline,
      });

      const gSigB = await signGuardian(queue, guardianAlice, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceOther.address, nonce: 0, deadline,
      });

      await expect(queue.openClaim(ALICE_ID, alice.address, aliceOther.address, deadline, sigB, gSigB))
        .to.emit(queue, "ClaimOpened");
    });

    it("does not block a second claim once the first is executed", async function () {
      await token.connect(admin).mint(alice.address, 10n * ONE);
      await registry.connect(attestor).bindWallet(ALICE_ID, aliceOther.address, guardianAlice.address);

      const sigA = await attest(queue, attestor, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });

      const gSigA = await signGuardian(queue, guardianAlice, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });

      await queue.openClaim(ALICE_ID, alice.address, aliceNew.address, deadline, sigA, gSigA);
      await queue.connect(issuer).approve(0);
      await time.increase(CURE + 1);
      await executor.execute(0);

      // alice's balance is now 0, but the guard is about claim exclusivity,
      // not balance — a fresh claim on the same oldWallet must be allowed
      // to open again now that the prior one is resolved.
      const sigB = await attest(queue, attestor, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceOther.address, nonce: 0, deadline,
      });

      const gSigB = await signGuardian(queue, guardianAlice, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceOther.address, nonce: 0, deadline,
      });

      await expect(queue.openClaim(ALICE_ID, alice.address, aliceOther.address, deadline, sigB, gSigB))
        .to.emit(queue, "ClaimOpened");
    });

    it("does NOT block a claim against a different oldWallet entirely", async function () {
      const sigAlice = await attest(queue, attestor, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });

      const gSigAlice = await signGuardian(queue, guardianAlice, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });

      await queue.openClaim(ALICE_ID, alice.address, aliceNew.address, deadline, sigAlice, gSigAlice);

      await registry.connect(attestor).bindWallet(BOB_ID, aliceOther.address, guardianBob.address);
      const sigBob = await attest(queue, attestor, {
        personId: BOB_ID, oldWallet: bob.address,
        newWallet: aliceOther.address, nonce: 0, deadline,
      });

      const gSigBob = await signGuardian(queue, guardianBob, {
        personId: BOB_ID, oldWallet: bob.address,
        newWallet: aliceOther.address, nonce: 0, deadline,
      });

      // Bob's claim is unrelated to Alice's oldWallet, so it must go through
      // even while Alice's claim is still active.
      await expect(queue.openClaim(BOB_ID, bob.address, aliceOther.address, deadline, sigBob, gSigBob))
        .to.emit(queue, "ClaimOpened");
    });
  });

  // --------------------------------------------------------- the recovery

  describe("Recovery execution", function () {
    async function openApprovedClaim() {
      const deadline = (await time.latest()) + 3600;
      const sig = await attest(queue, attestor, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });
      const gSig = await signGuardian(queue, guardianAlice, {
        personId: ALICE_ID, oldWallet: alice.address,
        newWallet: aliceNew.address, nonce: 0, deadline,
      });
      await queue.openClaim(ALICE_ID, alice.address, aliceNew.address, deadline, sig, gSig);
      await queue.connect(issuer).approve(0);
      return 0;
    }

    it("HAPPY PATH: recovers the full balance from a revoked wallet", async function () {
      await token.connect(admin).mint(alice.address, 250n * ONE);
      const id = await openApprovedClaim();

      // The old wallet is revoked, exactly as it would be in production.
      await registry.connect(attestor).revokeWallet(alice.address, "recovery: rotated");
      await time.increase(CURE + 1);

      await expect(executor.execute(id)).to.emit(executor, "RecoveryExecuted");

      expect(await token.balanceOf(alice.address)).to.equal(0n);
      expect(await token.balanceOf(aliceNew.address)).to.equal(250n * ONE);
    });

    it("THE TRAP: recoveryTransfer works even though the sender is revoked", async function () {
      // Without the _inRecovery flag this reverts with SenderBindingRevoked.
      // This test exists specifically to prove the flag works.
      await token.connect(admin).mint(alice.address, 10n * ONE);
      await registry.connect(attestor).revokeWallet(alice.address, "compromised");

      // Confirm a normal transfer really is blocked...
      await expect(token.connect(alice).transfer(aliceNew.address, ONE))
        .to.be.revertedWithCustomError(token, "SenderBindingRevoked");

      // ...but the recovery path is not.
      const id = await openApprovedClaim();
      await time.increase(CURE + 1);
      await executor.execute(id);
      expect(await token.balanceOf(aliceNew.address)).to.equal(10n * ONE);
    });

    it("the recovery flag does not leak: normal transfers stay gated afterwards", async function () {
      await token.connect(admin).mint(alice.address, 10n * ONE);
      await registry.connect(attestor).revokeWallet(alice.address, "compromised");
      const id = await openApprovedClaim();
      await time.increase(CURE + 1);
      await executor.execute(id);

      // The new wallet still cannot send to an unverified address.
      await expect(token.connect(aliceNew).transfer(attacker.address, ONE))
        .to.be.revertedWithCustomError(token, "RecipientNotEligible");
    });

    it("recovery still refuses an ineligible destination", async function () {
      await token.connect(admin).mint(alice.address, 10n * ONE);
      const id = await openApprovedClaim();
      await time.increase(CURE + 1);
      // Destination goes bad between approval and execution.
      await registry.connect(attestor).revokeWallet(aliceNew.address, "sanctioned");
      await expect(executor.execute(id))
        .to.be.revertedWithCustomError(token, "RecipientNotEligible");
    });

    it("only the executor may call recoveryTransfer", async function () {
      await token.connect(admin).mint(alice.address, 10n * ONE);
      await expect(token.connect(attacker).recoveryTransfer(alice.address, attacker.address, ONE))
        .to.be.revertedWithCustomError(token, "OnlyExecutor");
    });

    it("cannot execute twice", async function () {
      await token.connect(admin).mint(alice.address, 10n * ONE);
      const id = await openApprovedClaim();
      await time.increase(CURE + 1);
      await executor.execute(id);
      await expect(executor.execute(id))
        .to.be.revertedWithCustomError(executor, "NotExecutable");
    });

    it("cannot execute a cancelled claim", async function () {
      await token.connect(admin).mint(alice.address, 10n * ONE);
      const id = await openApprovedClaim();
      await queue.connect(issuer).cancel(id);
      await time.increase(CURE + 1);
      await expect(executor.execute(id))
        .to.be.revertedWithCustomError(executor, "NotExecutable");
    });

    it("cannot execute early", async function () {
      await token.connect(admin).mint(alice.address, 10n * ONE);
      const id = await openApprovedClaim();
      await expect(executor.execute(id))
        .to.be.revertedWithCustomError(executor, "NotExecutable");
    });
  });
});
