const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Guardian replacement queue", function () {
  let admin, attestor, issuer, alice, bob, newGuardian, outsider;
  let registry, token, queue, guardianQueue;
  let ALICE_ID, chainId;

  const CURE = 30;

  const signGuardianChange = async (signer, verifyingContract, payload) => {
    return await signer.signTypedData(
      { name: "RebindGuardian", version: "1", chainId, verifyingContract },
      {
        GuardianChangeRequest: [
          { name: "personId", type: "bytes32" },
          { name: "wallet", type: "address" },
          { name: "oldGuardian", type: "address" },
          { name: "newGuardian", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      payload
    );
  };

  const signClaim = async (signer, verifyingContract, payload) => {
    return await signer.signTypedData(
      { name: "Rebind", version: "1", chainId, verifyingContract },
      {
        RecoveryClaim: [
          { name: "personId", type: "bytes32" },
          { name: "oldWallet", type: "address" },
          { name: "newWallet", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      payload
    );
  };

  const signGuardianClaim = async (signer, verifyingContract, payload) => {
    return await signer.signTypedData(
      { name: "Rebind", version: "1", chainId, verifyingContract },
      {
        GuardianRecoveryClaim: [
          { name: "personId", type: "bytes32" },
          { name: "oldWallet", type: "address" },
          { name: "newWallet", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      payload
    );
  };

  beforeEach(async function () {
    [admin, attestor, issuer, alice, bob, newGuardian, outsider] = await ethers.getSigners();
    chainId = Number((await ethers.provider.getNetwork()).chainId);

    ALICE_ID = ethers.keccak256(ethers.toUtf8Bytes("ALICECUST0001"));

    registry = await (await ethers.getContractFactory("BindingRegistry"))
      .deploy(admin.address, attestor.address);
    token = await (await ethers.getContractFactory("RebindableRWA"))
      .deploy("Series A Note", "NOTE", 6, await registry.getAddress(), admin.address);
    queue = await (await ethers.getContractFactory("RecoveryQueue"))
      .deploy(await registry.getAddress(), attestor.address, admin.address, CURE);

    guardianQueue = await (await ethers.getContractFactory("GuardianReplacementQueue")).deploy(
      await registry.getAddress(),
      await queue.getAddress(),
      attestor.address,
      admin.address,
      CURE
    );

    // Circular wiring
    await (await registry.setRecoveryQueue(await queue.getAddress())).wait();
    await (await registry.setGuardianQueue(await guardianQueue.getAddress())).wait();
    await (await queue.setGuardianReplacementQueue(await guardianQueue.getAddress())).wait();

    // Bind Alice
    await registry.connect(attestor).bindWallet(ALICE_ID, alice.address, bob.address);
  });

  describe("Lifecycle & Attestation", function () {
    it("Happy path: open -> wait out window -> finalize -> guardianOf updated", async function () {
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      const payload = {
        personId: ALICE_ID,
        wallet: alice.address,
        oldGuardian: bob.address,
        newGuardian: newGuardian.address,
        nonce: 0,
        deadline,
      };

      const sig = await signGuardianChange(attestor, await guardianQueue.getAddress(), payload);

      await expect(
        guardianQueue.connect(outsider).openRequest(
          ALICE_ID,
          alice.address,
          bob.address,
          newGuardian.address,
          deadline,
          sig
        )
      )
        .to.emit(guardianQueue, "RequestOpened");

      const req = await guardianQueue.getRequest(0);
      expect(req.personId).to.equal(ALICE_ID);
      expect(req.wallet).to.equal(alice.address);
      expect(req.oldGuardian).to.equal(bob.address);
      expect(req.newGuardian).to.equal(newGuardian.address);
      expect(req.finalized).to.equal(false);

      // finalize before window reverts
      await expect(guardianQueue.finalize(0))
        .to.be.revertedWithCustomError(guardianQueue, "CureWindowActive");

      // elapse window
      await ethers.provider.send("evm_increaseTime", [CURE + 1]);
      await ethers.provider.send("evm_mine", []);

      // finalize works
      await expect(guardianQueue.connect(outsider).finalize(0))
        .to.emit(guardianQueue, "RequestFinalized")
        .withArgs(0, newGuardian.address)
        .and.to.emit(registry, "GuardianReplaced")
        .withArgs(ALICE_ID, newGuardian.address);

      expect(await registry.guardianOf(ALICE_ID)).to.equal(newGuardian.address);
    });

    it("attestor signature required; request signed by anyone else reverts", async function () {
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      const payload = {
        personId: ALICE_ID,
        wallet: alice.address,
        oldGuardian: bob.address,
        newGuardian: newGuardian.address,
        nonce: 0,
        deadline,
      };

      const sig = await signGuardianChange(outsider, await guardianQueue.getAddress(), payload);

      await expect(
        guardianQueue.openRequest(
          ALICE_ID,
          alice.address,
          bob.address,
          newGuardian.address,
          deadline,
          sig
        )
      ).to.be.revertedWithCustomError(guardianQueue, "BadAttestation");
    });

    it("issuer can cancel during the window; cancelled request cannot finalize", async function () {
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      const payload = {
        personId: ALICE_ID,
        wallet: alice.address,
        oldGuardian: bob.address,
        newGuardian: newGuardian.address,
        nonce: 0,
        deadline,
      };

      const sig = await signGuardianChange(attestor, await guardianQueue.getAddress(), payload);
      await guardianQueue.openRequest(ALICE_ID, alice.address, bob.address, newGuardian.address, deadline, sig);

      // outsider cannot cancel
      await expect(guardianQueue.connect(outsider).cancel(0)).to.be.reverted;

      // issuer cancels
      await expect(guardianQueue.connect(admin).cancel(0))
        .to.emit(guardianQueue, "RequestCancelled")
        .withArgs(0, admin.address);

      // elapse window
      await ethers.provider.send("evm_increaseTime", [CURE + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(guardianQueue.finalize(0)).to.be.revertedWithCustomError(guardianQueue, "RequestClosed");
    });

    it("reverts with StaleGuardian if the signed oldGuardian no longer matches the live registry value", async function () {
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      const payload = {
        personId: ALICE_ID,
        wallet: alice.address,
        oldGuardian: outsider.address, // signed oldGuardian differs from registry's bob.address
        newGuardian: newGuardian.address,
        nonce: 0,
        deadline,
      };

      const sig = await signGuardianChange(attestor, await guardianQueue.getAddress(), payload);

      await expect(
        guardianQueue.openRequest(
          ALICE_ID,
          alice.address,
          outsider.address,
          newGuardian.address,
          deadline,
          sig
        )
      )
        .to.be.revertedWithCustomError(guardianQueue, "StaleGuardian")
        .withArgs(outsider.address, bob.address);
    });

    it("requires registry.isActive(wallet) to open a request", async function () {
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      const payload = {
        personId: ALICE_ID,
        wallet: alice.address,
        oldGuardian: bob.address,
        newGuardian: newGuardian.address,
        nonce: 0,
        deadline,
      };

      const sig = await signGuardianChange(attestor, await guardianQueue.getAddress(), payload);

      // Revoke wallet
      await registry.connect(attestor).revokeWallet(alice.address, "revoked");

      await expect(
        guardianQueue.openRequest(
          ALICE_ID,
          alice.address,
          bob.address,
          newGuardian.address,
          deadline,
          sig
        )
      ).to.be.revertedWithCustomError(guardianQueue, "WalletNotActive");
    });

    it("enforces nonce/replay protection logic per wallet", async function () {
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      const payload = {
        personId: ALICE_ID,
        wallet: alice.address,
        oldGuardian: bob.address,
        newGuardian: newGuardian.address,
        nonce: 0,
        deadline,
      };

      const sig = await signGuardianChange(attestor, await guardianQueue.getAddress(), payload);
      await guardianQueue.openRequest(ALICE_ID, alice.address, bob.address, newGuardian.address, deadline, sig);

      // elapse window and finalize
      await ethers.provider.send("evm_increaseTime", [CURE + 1]);
      await ethers.provider.send("evm_mine", []);
      await guardianQueue.finalize(0);

      // Replaying the exact same signature with nonce 0 (now stale) reverts
      await expect(
        guardianQueue.openRequest(
          ALICE_ID,
          alice.address,
          newGuardian.address,
          bob.address,
          deadline,
          sig
        )
      ).to.be.revertedWithCustomError(guardianQueue, "BadAttestation");
    });
  });

  describe("Cross-Contract Blocking Checks", function () {
    it("active recovery claim blocks opening a guardian change request", async function () {
      const [, , , , , , , aliceNew] = await ethers.getSigners();
      // Bind aliceNew
      await registry.connect(attestor).bindWallet(ALICE_ID, aliceNew.address, bob.address);

      // Open a recovery claim
      const claimDeadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      const claimPayload = {
        personId: ALICE_ID,
        oldWallet: alice.address,
        newWallet: aliceNew.address,
        nonce: 0,
        deadline: claimDeadline,
      };

      const attestorSig = await signClaim(attestor, await queue.getAddress(), claimPayload);
      const guardianSig = await signGuardianClaim(bob, await queue.getAddress(), claimPayload);

      await queue.openClaim(ALICE_ID, alice.address, aliceNew.address, claimDeadline, attestorSig, guardianSig);

      // Try to open a guardian change request on the same wallet
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      const gPayload = {
        personId: ALICE_ID,
        wallet: alice.address,
        oldGuardian: bob.address,
        newGuardian: newGuardian.address,
        nonce: 0,
        deadline,
      };
      const gSig = await signGuardianChange(attestor, await guardianQueue.getAddress(), gPayload);

      await expect(
        guardianQueue.openRequest(ALICE_ID, alice.address, bob.address, newGuardian.address, deadline, gSig)
      ).to.be.revertedWithCustomError(guardianQueue, "RecoveryClaimActive");
    });

    it("pending guardian change request blocks opening a recovery claim", async function () {
      const [, , , , , , , aliceNew] = await ethers.getSigners();
      // Bind aliceNew
      await registry.connect(attestor).bindWallet(ALICE_ID, aliceNew.address, bob.address);

      // Open guardian change request
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      const gPayload = {
        personId: ALICE_ID,
        wallet: alice.address,
        oldGuardian: bob.address,
        newGuardian: newGuardian.address,
        nonce: 0,
        deadline,
      };
      const gSig = await signGuardianChange(attestor, await guardianQueue.getAddress(), gPayload);
      await guardianQueue.openRequest(ALICE_ID, alice.address, bob.address, newGuardian.address, deadline, gSig);

      // Try to open recovery claim
      const claimDeadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      const claimPayload = {
        personId: ALICE_ID,
        oldWallet: alice.address,
        newWallet: aliceNew.address,
        nonce: 0,
        deadline: claimDeadline,
      };

      const attestorSig = await signClaim(attestor, await queue.getAddress(), claimPayload);
      const guardianSig = await signGuardianClaim(bob, await queue.getAddress(), claimPayload);

      await expect(
        queue.openClaim(ALICE_ID, alice.address, aliceNew.address, claimDeadline, attestorSig, guardianSig)
      )
        .to.be.revertedWithCustomError(queue, "GuardianChangePending")
        .withArgs(ALICE_ID);
    });

    it("two guardian-change requests cannot be open on the same personId simultaneously", async function () {
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      const gPayload = {
        personId: ALICE_ID,
        wallet: alice.address,
        oldGuardian: bob.address,
        newGuardian: newGuardian.address,
        nonce: 0,
        deadline,
      };
      const gSig = await signGuardianChange(attestor, await guardianQueue.getAddress(), gPayload);
      await guardianQueue.openRequest(ALICE_ID, alice.address, bob.address, newGuardian.address, deadline, gSig);

      // Try to open a second one
      const gPayload2 = {
        personId: ALICE_ID,
        wallet: alice.address,
        oldGuardian: bob.address,
        newGuardian: outsider.address,
        nonce: 1,
        deadline,
      };
      const gSig2 = await signGuardianChange(attestor, await guardianQueue.getAddress(), gPayload2);

      await expect(
        guardianQueue.openRequest(ALICE_ID, alice.address, bob.address, outsider.address, deadline, gSig2)
      )
        .to.be.revertedWithCustomError(guardianQueue, "RequestAlreadyActive")
        .withArgs(ALICE_ID, 0);
    });
  });

  describe("Access Control", function () {
    it("registry.updateGuardian is only callable by the wired GuardianReplacementQueue", async function () {
      await expect(registry.connect(admin).updateGuardian(ALICE_ID, newGuardian.address))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");

      await expect(registry.connect(outsider).updateGuardian(ALICE_ID, newGuardian.address))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });
  });
});
