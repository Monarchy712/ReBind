/**
 * Rebind demo backend.
 *
 * Runs the whole flow end to end:
 *   register -> mint -> blocked theft -> claim -> cure -> approve -> execute
 *
 * Start:  node backend/server.js
 * Needs:  .env  (copy from .env.example)
 */
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const { ethers } = require("ethers");

const cv = require("./cleanverse");
const { Attestor, personIdOf } = require("./attestor");
const normalizePrivateKey = (value) => value && (value.startsWith("0x") ? value : `0x${value}`);

const D = require("../deployments.json"); // written by scripts/deploy.js

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "frontend")));

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const issuer = new ethers.Wallet(normalizePrivateKey(process.env.DEPLOYER_PK), provider);
const attestorWallet = new ethers.Wallet(normalizePrivateKey(process.env.ATTESTOR_PK), provider);

const abi = (n) => require(`../artifacts/contracts/${n}.sol/${n}.json`).abi;
const registry = new ethers.Contract(D.registry, abi("BindingRegistry"), attestorWallet);
const token = new ethers.Contract(D.token, abi("RebindableRWA"), issuer);
const queue = new ethers.Contract(D.queue, abi("RecoveryQueue"), issuer);
const executor = new ethers.Contract(D.executor, abi("RebindExecutor"), issuer);
const mirrorFreezeToCleanverse = process.env.CV_FREEZE_PER_WALLET === "true";

let attestor;
(async () => {
  const net = await provider.getNetwork();
  attestor = new Attestor({
    privateKey: normalizePrivateKey(process.env.ATTESTOR_PK),
    queueAddress: D.queue,
    chainId: Number(net.chainId),
  });
  console.log(`Rebind backend`);
  console.log(`  chain    ${net.chainId}`);
  console.log(`  token    ${D.token}`);
  console.log(`  attestor ${attestor.address}`);
})();

const ok = (res, data) => res.json({ ok: true, ...data });
const fail = (res, e) => {
  console.error(e);
  res.status(400).json({ ok: false, error: e.message, proof: e.proof });
};

// ---- 1. register a person + wallet -----------------------------------------
app.post("/api/register", async (req, res) => {
  try {
    const { customerId, address, override } = req.body;
    const identityCommitment = personIdOf(customerId);

    // Registration may be retried after a browser refresh. Do not try to bind
    // the same wallet twice; BindingRegistry intentionally makes bindings
    // immutable to prevent a wallet being silently reassigned to another ID.
    if (await registry.matchesIdentity(address, identityCommitment)) {
      return ok(res, { reused: true, cleanverse: null, onchainTx: null });
    }
    if (await registry.isActive(address) || await registry.revoked(address)) {
      throw new Error("This wallet is already bound to a different customer identity. Use the original demo session or a fresh wallet.");
    }

    const cvRes = await cv.generateApass({ customerId, address, override });
    if (String(cvRes.code) !== "0000") throw new Error(`Cleanverse: ${cvRes.message}`);

    const tx = await registry.bindWallet(identityCommitment, address);
    await tx.wait();

    ok(res, { cleanverse: cvRes.data, onchainTx: tx.hash });
  } catch (e) { fail(res, e); }
});

// ---- 2. mint the asset ------------------------------------------------------
app.post("/api/mint", async (req, res) => {
  try {
    const { to, amount } = req.body;
    const tx = await token.mint(to, ethers.parseUnits(String(amount), 6));
    await tx.wait();
    ok(res, { txHash: tx.hash, balance: (await token.balanceOf(to)).toString() });
  } catch (e) { fail(res, e); }
});

// ---- 3. pre-flight check (the blocked-theft beat) ---------------------------
app.post("/api/check", async (req, res) => {
  try {
    const { from, to, amount } = req.body;
    // ERC-1404 is two calls by design: a cheap numeric code, then the text.
    const value = amount ? ethers.parseUnits(String(amount), 6) : 0n;
    const code = await token.detectTransferRestriction(from, to, value);
    const reason = await token.messageForTransferRestriction(code);
    const cvVerdict = await cv.verifyApass({ address: to, atoken: D.token });
    ok(res, { onchain: { code: Number(code), reason }, cleanverse: cvVerdict });
  } catch (e) { fail(res, e); }
});

// ---- 4. open a recovery claim ----------------------------------------------
app.post("/api/claim", async (req, res) => {
  try {
    const { customerId, oldWallet, newWallet } = req.body;

    const nonce = await queue.nonces(newWallet);
    const att = await attestor.signClaim({
      customerId, oldWallet, newWallet, nonce: Number(nonce),
    });

    const tx = await queue.openClaim(
      att.personId, oldWallet, newWallet, att.deadline, att.signature
    );
    const rcpt = await tx.wait();

    let cleanverseFreeze = null;
    if (mirrorFreezeToCleanverse) {
      cleanverseFreeze = await cv.updateStatus({
        customerId, address: oldWallet, status: 2, reason: "recovery claim pending",
      });
      if (String(cleanverseFreeze.code) !== "0000") {
        throw new Error(`Claim opened on-chain but Cleanverse freeze failed: ${cleanverseFreeze.message}`);
      }
    }

    const ev = rcpt.logs
      .map((l) => { try { return queue.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "ClaimOpened");

    ok(res, {
      claimId: ev ? Number(ev.args.claimId) : null,
      executableAt: ev ? Number(ev.args.executableAt) : null,
      proof: att.proof,
      txHash: tx.hash,
      cleanverseFreezeTx: cleanverseFreeze?.data?.txHash || null,
    });
  } catch (e) { fail(res, e); }
});

// ---- 5. claim status (drives the countdown) --------------------------------
app.get("/api/claim/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const c = await queue.getClaim(id);
    ok(res, {
      claim: {
        personId: c.personId,
        oldWallet: c.oldWallet,
        newWallet: c.newWallet,
        executableAt: Number(c.executableAt),
        cancelled: c.cancelled,
        executed: c.executed,
        issuerApproved: c.issuerApproved,
      },
      timeRemaining: Number(await queue.timeRemaining(id)),
      executable: await queue.isExecutable(id),
    });
  } catch (e) { fail(res, e); }
});

// ---- 6. issuer countersigns -------------------------------------------------
app.post("/api/approve", async (req, res) => {
  try {
    const tx = await queue.approve(Number(req.body.claimId));
    await tx.wait();
    ok(res, { txHash: tx.hash });
  } catch (e) { fail(res, e); }
});

// ---- 6b. issuer rejects a disputed claim ------------------------------------
// Deliberately issuer-only, mirroring RecoveryQueue.cancel(). In a stolen-key
// scenario the old wallet is the attacker, who must not hold a veto over the
// rightful owner's recovery. Cancelling restores the old binding.
app.post("/api/cancel", async (req, res) => {
  try {
    const tx = await queue.cancel(Number(req.body.claimId));
    await tx.wait();
    ok(res, { txHash: tx.hash });
  } catch (e) { fail(res, e); }
});

// Legacy UI compatibility. RecoveryQueue freezes the binding atomically at
// claim opening; calling this endpoint must never perform a second transition.
app.post("/api/revoke", async (_req, res) => {
  ok(res, { onchainAlreadyFrozen: true, cleanverseTx: null });
});

// ---- 7. execute the recovery ------------------------------------------------
app.post("/api/execute", async (req, res) => {
  try {
    const { claimId } = req.body;
    const id = Number(claimId);
    if (!await queue.isExecutable(id)) {
      const c = await queue.getClaim(id);
      if (c.cancelled) throw new Error("Claim was rejected during issuer review.");
      if (!c.issuerApproved) throw new Error("Claim still needs issuer approval.");
      const remaining = Number(await queue.timeRemaining(id));
      throw new Error(`Challenge window is still active. Wait ${remaining} more second(s).`);
    }
    const tx = await executor.execute(id);
    const rcpt = await tx.wait();
    const c = await queue.getClaim(id);
    ok(res, {
      txHash: tx.hash,
      block: rcpt.blockNumber,
      newBalance: (await token.balanceOf(c.newWallet)).toString(),
      oldBalance: (await token.balanceOf(c.oldWallet)).toString(),
    });
  } catch (e) { fail(res, e); }
});

// ---- state for the UI -------------------------------------------------------
app.get("/api/state", async (req, res) => {
  try {
    const { wallets } = req.query;
    const list = (wallets || "").split(",").filter(Boolean);
    const out = {};
    for (const w of list) {
      out[w] = {
        balance: ethers.formatUnits(await token.balanceOf(w), 6),
        revoked: await registry.revoked(w),
        active: await registry.isActive(w),
      };
    }
    ok(res, { wallets: out, contracts: D, claimCount: Number(await queue.claimCount()) });
  } catch (e) { fail(res, e); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`  http://localhost:${PORT}`));
