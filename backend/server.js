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
const fs = require("fs");
const { ethers } = require("ethers");

const cv = require("./cleanverse-client");
const LOCAL_MODE = process.env.DEMO_MODE === "local";
const { Attestor, personIdOf } = require("./attestor");
const normalizePrivateKey = (value) => value && (value.startsWith("0x") ? value : `0x${value}`);

const D = require("../deployments.json"); // written by scripts/deploy.js

const app = express();
app.use(cors());
app.use(express.json());
const WEB_DIST = path.join(__dirname, "..", "frontend", "dist");
if (fs.existsSync(path.join(WEB_DIST, "index.html"))) {
  app.use(express.static(WEB_DIST));
} else {
  app.use(express.static(path.join(__dirname, "..", "frontend")));
}

// In local mode the contracts live on the Hardhat node, not on RPC_URL — which
// still holds the testnet endpoint so switching modes needs no .env edit.
// cacheTimeout: -1 disables ethers' response cache; the UI polls claim state
// right after writing it, and a cached read makes the countdown appear stuck.
const RPC_URL = LOCAL_MODE ? (process.env.LOCAL_RPC || "http://127.0.0.1:8545") : process.env.RPC_URL;
const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
const issuer = new ethers.Wallet(normalizePrivateKey(process.env.DEPLOYER_PK), provider);
const attestorWallet = new ethers.Wallet(normalizePrivateKey(process.env.ATTESTOR_PK), provider);

const abi = (n) => require(`../artifacts/contracts/${n}.sol/${n}.json`).abi;
const registry = new ethers.Contract(D.registry, abi("BindingRegistry"), attestorWallet);
const token = new ethers.Contract(D.token, abi("RebindableRWA"), issuer);
const queue = new ethers.Contract(D.queue, abi("RecoveryQueue"), issuer);
const executor = new ethers.Contract(D.executor, abi("RebindExecutor"), issuer);
const guardianQueue = D.guardianQueue ? new ethers.Contract(D.guardianQueue, abi("GuardianReplacementQueue"), issuer) : null;

// Bridge advances are optional: a deployment without a vault simply has no
// advance endpoints, and every other route behaves identically.
const vault = D.vault ? new ethers.Contract(D.vault, abi("BridgeAdvanceVault"), issuer) : null;
const stable = D.stable ? new ethers.Contract(D.stable, abi("DemoStablecoin"), issuer) : null;
const noAdvances = (res) =>
  res.status(404).json({ ok: false, error: "This deployment has no bridge advance vault." });
const mirrorFreezeToCleanverse = process.env.CV_FREEZE_PER_WALLET === "true";

/**
 * Confirms deployments.json describes the chain we are actually pointed at.
 *
 * Without this, a stale deployments.json (a restarted Hardhat node, a deploy to
 * one network while the backend reads another) starts a healthy-looking server
 * whose every route fails at request time with `could not decode result data
 * (value="0x")`. That reads as an ABI bug and is really a wiring mistake, so
 * catch it at boot where the fix is obvious.
 */
async function assertDeploymentMatchesChain(net) {
  if (Number(net.chainId) !== D.chainId) {
    throw new Error(
      `deployments.json was written on chainId ${D.chainId} (${D.network}) but ${RPC_URL} is ` +
      `chainId ${net.chainId}.\n` +
      (LOCAL_MODE
        ? `Redeploy against the local node:  npm run deploy:local`
        : `Either start in local mode (npm run server:local) or redeploy:  npm run deploy`)
    );
  }

  const contracts = { registry: D.registry, token: D.token, queue: D.queue, executor: D.executor };
  if (D.vault) contracts.vault = D.vault;
  if (D.stable) contracts.stable = D.stable;
  if (D.guardianQueue) contracts.guardianQueue = D.guardianQueue;

  const missing = [];
  for (const [name, addr] of Object.entries(contracts)) {
    if ((await provider.getCode(addr)) === "0x") missing.push(`${name} (${addr})`);
  }
  if (missing.length) {
    throw new Error(
      `No contract code at: ${missing.join(", ")}.\n` +
      `deployments.json is from ${D.deployedAt} and no longer matches this chain — ` +
      `${LOCAL_MODE ? "the node was probably restarted. Re-run:  npm run fund:local && npm run deploy:local"
                    : "redeploy:  npm run deploy"}`
    );
  }
}

let attestor;
(async () => {
  const net = await provider.getNetwork();
  await assertDeploymentMatchesChain(net);

  attestor = new Attestor({
    privateKey: normalizePrivateKey(process.env.ATTESTOR_PK),
    queueAddress: D.queue,
    guardianQueueAddress: D.guardianQueue,
    chainId: Number(net.chainId),
  });

  // The guardian is only a fourth layer if it is a genuinely different key from
  // the attestor. Refuse to start rather than serve a demo that claims four
  // independent signers and has three.
  const gKey = guardianKey();
  const guardianAddr = gKey ? new ethers.Wallet(gKey).address : null;
  if (guardianAddr && guardianAddr.toLowerCase() === attestorWallet.address.toLowerCase()) {
    throw new Error(
      "GUARDIAN_PK resolves to the same address as ATTESTOR_PK. The guardian co-signature " +
      "only adds a layer if the two keys are independent."
    );
  }

  console.log(`Rebind backend`);
  console.log(`  mode     ${LOCAL_MODE ? "LOCAL (in-memory Cleanverse stub)" : "live (Cleanverse API)"}`);
  console.log(`  chain    ${net.chainId} @ ${RPC_URL}`);
  console.log(`  token    ${D.token}`);
  console.log(`  attestor ${attestor.address}`);
  if (guardianAddr) {
    console.log(`  guardian ${guardianAddr}`);
  } else {
    console.warn("  guardian (none) — /api/claim will require a guardianSignature in the request body");
  }
})().catch((e) => {
  // These are setup errors with a stated fix, not crashes. Print the fix, not a
  // stack trace, and refuse to listen rather than serve a broken backend.
  console.error(`\nRebind backend cannot start:\n\n${e.message}\n`);
  process.exit(1);
});

const ok = (res, data) => res.json({ ok: true, ...data });

/**
 * Custom errors are the whole point of this codebase's revert strategy, but
 * ethers cannot name one it has no ABI for — it reports "unknown custom error"
 * plus a selector, which is what the UI would otherwise show a user. Decode
 * against every contract we know so a refusal explains itself.
 */
const ERROR_ABIS = ["RecoveryQueue", "RebindableRWA", "BindingRegistry", "RebindExecutor", "BridgeAdvanceVault", "GuardianReplacementQueue"]
  .map((n) => { try { return new ethers.Interface(abi(n)); } catch { return null; } })
  .filter(Boolean);

function decodeRevert(e) {
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  if (typeof data !== "string" || data.length < 10) return null;
  for (const iface of ERROR_ABIS) {
    try {
      const parsed = iface.parseError(data);
      if (!parsed) continue;
      const args = parsed.args.map((a) => a.toString()).join(", ");
      return args ? `${parsed.name}(${args})` : `${parsed.name}()`;
    } catch { /* not this contract's error */ }
  }
  return null;
}

const fail = (res, e) => {
  console.error(e);
  const decoded = decodeRevert(e);
  res.status(400).json({ ok: false, error: decoded || e.shortMessage || e.message, proof: e.proof });
};

// ---- 1. register a person + wallet -----------------------------------------
app.post("/api/register", async (req, res) => {
  try {
    const { customerId, address, override, guardianAddress } = req.body;
    if (!guardianAddress || !ethers.isAddress(guardianAddress) || guardianAddress === ethers.ZeroAddress) {
      throw new Error("guardianAddress is required and must be a valid non-zero address");
    }
    if (guardianAddress.toLowerCase() === address.toLowerCase()) {
      throw new Error("guardianAddress cannot be the same as the wallet being registered");
    }
    if (guardianAddress.toLowerCase() === attestorWallet.address.toLowerCase()) {
      throw new Error("guardianAddress cannot be the attestor's address");
    }
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

    console.log("DEBUG /api/register:", { customerId, address });
    let cvRes = await cv.generateApass({ customerId, address, override });
    if (String(cvRes?.code) === "CV_500" || String(cvRes?.code) === "-1") {
      await new Promise(r => setTimeout(r, 600));
      cvRes = await cv.generateApass({ customerId, address, override: true });
    }
    if (String(cvRes.code) !== "0000") throw new Error(`Cleanverse: ${cvRes.message}`);

    const tx = await registry.bindWallet(identityCommitment, address, guardianAddress);
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
    const { customerId, oldWallet, newWallet, guardianSignature, guardianPrivateKey } = req.body;
    console.log("DEBUG /api/claim:", { customerId, oldWallet, newWallet, guardianPrivateKey });

    const nonce = await queue.nonces(newWallet);
    const block = await provider.getBlock("latest");
    const blockTime = Number(block?.timestamp || 0);
    const now = Math.floor(Date.now() / 1000);
    const ttlSeconds = blockTime > now ? (blockTime - now) + 86400 : 86400;

    const att = await attestor.signClaim({
      customerId, oldWallet, newWallet, nonce: Number(nonce), ttlSeconds,
    });

    // Guardian co-signature collection. A real deployment would collect this
    // from the guardian out-of-band and pass it in as `guardianSignature`; for
    // the demo we also accept a guardian key and co-sign here.
    let guardianSig = guardianSignature;
    let guardianAddress = null;
    if (!guardianSig) {
      // Deliberately no ATTESTOR_PK fallback: signing the guardian's half with
      // the attestor's key would make the co-signature a formality and the
      // "four independent layers" claim untrue.
      const gKey = (guardianPrivateKey && normalizePrivateKey(guardianPrivateKey)) || guardianKey();
      if (!gKey) {
        throw new Error(
          "No guardian key. Opening a claim needs the nominated guardian's co-signature — " +
          "pass guardianSignature, or set GUARDIAN_PK. It must NOT be the attestor key."
        );
      }
      const gRes = await attestor.signGuardianClaim({
        privateKey: gKey,
        customerId,
        oldWallet,
        newWallet,
        nonce: Number(nonce),
        deadline: att.deadline,
      });
      guardianSig = gRes.signature;
      guardianAddress = gRes.guardian;
    }

    const tx = await queue.openClaim(
      att.personId, oldWallet, newWallet, att.deadline, att.signature, guardianSig
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
      // Who actually co-signed, so the UI can name the second signer instead of
      // asserting one was involved. Null when the caller supplied the signature
      // themselves and we never saw the key.
      guardian: guardianAddress,
      cleanverseFreezeTx: cleanverseFreeze?.data?.txHash || null,
    });
  } catch (e) { fail(res, e); }
});

// ---- 4b. guardian co-signing endpoint --------------------------------------
app.post("/api/guardian-sign", async (req, res) => {
  try {
    const { customerId, oldWallet, newWallet, nonce, deadline, guardianPrivateKey } = req.body;
    // Same rule as /api/claim: the guardian's half is never signed with the
    // attestor key, so there is no ATTESTOR_PK fallback here either.
    const privKey = (guardianPrivateKey && normalizePrivateKey(guardianPrivateKey)) || guardianKey();
    if (!privKey) throw new Error("guardianPrivateKey is required to co-sign");
    const gSig = await attestor.signGuardianClaim({
      privateKey: privKey,
      customerId,
      oldWallet,
      newWallet,
      nonce: Number(nonce !== undefined ? nonce : await queue.nonces(newWallet)),
      deadline: deadline ? Number(deadline) : undefined,
    });
    ok(res, gSig);
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
        // Needed by the UI to resume onto the advance beat, and by anything
        // deciding whether this claim can be lent against.
        committed: c.committed,
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

// ---- 6c. fast-forward time on local dev node -------------------------------
app.post("/api/advance-time", async (req, res) => {
  try {
    const seconds = Number(req.body.seconds || 3600);
    await provider.send("evm_increaseTime", [seconds]);
    await provider.send("evm_mine", []);
    ok(res, { advanced: seconds });
  } catch (e) {
    ok(res, { advanced: 0, note: e.message });
  }
});

// Legacy UI compatibility. RecoveryQueue freezes the binding atomically at
// claim opening; calling this endpoint must never perform a second transition.
app.post("/api/revoke", async (_req, res) => {
  ok(res, { onchainAlreadyFrozen: true, cleanverseTx: null });
});

// ---- 6c. issuer commits, waiving its own right to cancel --------------------
// The precondition for lending. Until this is called, "approved" is revocable
// and a pending claim is not collateral.
app.post("/api/commit", async (req, res) => {
  try {
    const tx = await queue.commit(Number(req.body.claimId));
    await tx.wait();
    ok(res, { txHash: tx.hash });
  } catch (e) { fail(res, e); }
});

// ---- 6d. bridge advance -----------------------------------------------------
app.get("/api/advance/:id", async (req, res) => {
  try {
    if (!vault) return noAdvances(res);
    const id = Number(req.params.id);

    const [principalStable, dueNote] = await vault.quote(id);
    const a = await vault.getAdvance(id);
    const stableDecimals = Number(await stable.decimals());

    ok(res, {
      committed: await queue.isCommitted(id),
      quote: {
        principalStable: ethers.formatUnits(principalStable, stableDecimals),
        dueNote: ethers.formatUnits(dueNote, 6),
      },
      advance: {
        drawn: a.drawn,
        repaid: a.repaid,
        borrower: a.borrower,
        principalStable: ethers.formatUnits(a.principalStable, stableDecimals),
        dueNote: ethers.formatUnits(a.dueNote, 6),
      },
      liquidity: ethers.formatUnits(await vault.availableLiquidity(), stableDecimals),
      canDraw: borrowerSigner() !== null,
    });
  } catch (e) { fail(res, e); }
});

app.post("/api/advance/draw", async (req, res) => {
  try {
    if (!vault) return noAdvances(res);

    // Deliberately not signed by the issuer key. The vault only accepts a draw
    // from the claim's own new wallet, so that nobody can saddle a claimant
    // with a loan and its fee without consent.
    const signer = borrowerSigner();
    if (!signer) {
      throw new Error(
        "No borrower key available. The advance must be drawn by the claim's new wallet — " +
        "set DEMO_BORROWER_PK, or run the local demo where the wallets are disposable."
      );
    }

    const id = Number(req.body.claimId);

    // Use the gasless path: the borrower signs, the issuer key relays. A wallet
    // in the middle of recovering an asset may well hold no gas, so this is the
    // realistic flow rather than a convenience.
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const nonce = await vault.advanceNonces(signer.address);
    const net = await provider.getNetwork();
    const authorization = await signer.signTypedData(
      {
        name: "RebindAdvance",
        version: "1",
        chainId: Number(net.chainId),
        verifyingContract: D.vault,
      },
      {
        AdvanceAuthorization: [
          { name: "claimId", type: "uint256" },
          { name: "borrower", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { claimId: id, borrower: signer.address, nonce, deadline }
    );

    const tx = await vault.drawWithAuthorization(id, deadline, authorization);
    await tx.wait();

    const stableDecimals = Number(await stable.decimals());
    ok(res, {
      txHash: tx.hash,
      received: ethers.formatUnits(await stable.balanceOf(signer.address), stableDecimals),
      dueNote: ethers.formatUnits((await vault.getAdvance(id)).dueNote, 6),
    });
  } catch (e) { fail(res, e); }
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
    // Read the split before executing; afterwards the advance is settled and
    // repaymentDue() is 0, so the UI would have nothing to report.
    let split = null;
    if (vault) {
      const [total, toVault, toWallet] = await executor.previewSplit(id);
      if (toVault > 0n) {
        split = {
          total: ethers.formatUnits(total, 6),
          toVault: ethers.formatUnits(toVault, 6),
          toWallet: ethers.formatUnits(toWallet, 6),
        };
      }
    }

    const tx = await executor.execute(id);
    const rcpt = await tx.wait();
    const c = await queue.getClaim(id);
    ok(res, {
      txHash: tx.hash,
      block: rcpt.blockNumber,
      newBalance: (await token.balanceOf(c.newWallet)).toString(),
      oldBalance: (await token.balanceOf(c.oldWallet)).toString(),
      split,
    });
  } catch (e) { fail(res, e); }
});

// ---- demo config for the UI -------------------------------------------------
// The three demo wallets used to live in a `W` object the frontend expected you
// to hand-edit, which the README had to document as a setup step. They are
// configuration, so they come from the environment and the UI just asks.
/**
 * Drawing a bridge advance must be signed by the borrower — the vault only
 * accepts draw() from the claim's own new wallet, so nobody can push an
 * unwanted loan (and its fee) onto someone else.
 *
 * That means the demo needs a wallet B it can actually sign for. In local mode
 * the three demo wallets are therefore derived from the Hardhat node's own
 * mnemonic, which makes them pre-funded and disposable. On a real network the
 * addresses stay configuration and the borrower signs from their own wallet.
 */
const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";
const demoAccount = (i) =>
  ethers.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`);

const localDemoWallets = LOCAL_MODE
  ? { A: demoAccount(5), B: demoAccount(6), X: demoAccount(7), G: demoAccount(8) }
  : null;

const DEMO_WALLETS = {
  A: process.env.DEMO_WALLET_A || localDemoWallets?.A.address || "0xa34118bD1A2A789A962A4471C59c3964fb716123",
  B: process.env.DEMO_WALLET_B || localDemoWallets?.B.address || "0x7A0A94615094Ef0673f2D0F031D43fB9ED78cc0B",
  X: process.env.DEMO_WALLET_X || localDemoWallets?.X.address || "0x6d11172f538b60BE3a69c745944767Ac94019df7",
  G: process.env.DEMO_WALLET_G || localDemoWallets?.G.address || null,
};

/**
 * The guardian's signing key.
 *
 * The guardian exists so that compromising the attestor key is not enough to
 * forge a claim. Falling back to ATTESTOR_PK would quietly collapse that fourth
 * layer back into the third and make the demo assert a property it is not
 * actually demonstrating, so there is no such fallback anywhere. In local mode
 * we hold a genuinely separate key; otherwise the caller supplies GUARDIAN_PK
 * or the signature itself.
 */
function guardianKey() {
  if (process.env.GUARDIAN_PK) return normalizePrivateKey(process.env.GUARDIAN_PK);
  if (localDemoWallets) return localDemoWallets.G.privateKey;
  return null;
}

/** The signer that can draw an advance, or null if we hold no borrower key. */
function borrowerSigner() {
  if (process.env.DEMO_BORROWER_PK) {
    return new ethers.Wallet(normalizePrivateKey(process.env.DEMO_BORROWER_PK), provider);
  }
  if (localDemoWallets && DEMO_WALLETS.B === localDemoWallets.B.address) {
    return localDemoWallets.B.connect(provider);
  }
  return null;
}

// ---- 5. guardian replacement endpoints --------------------------------------
app.get("/api/guardian-replace/config", async (req, res) => {
  if (!guardianQueue) return res.status(404).json({ ok: false, error: "No guardian queue deployed." });
  try {
    ok(res, {
      address: D.guardianQueue,
      cureWindow: Number(await guardianQueue.cureWindow()),
    });
  } catch (e) { fail(res, e); }
});

app.post("/api/guardian-replace/open", async (req, res) => {
  if (!guardianQueue) return res.status(404).json({ ok: false, error: "No guardian queue deployed." });
  try {
    const { customerId, wallet, oldGuardian, newGuardian } = req.body;
    const nonce = await guardianQueue.nonces(wallet);

    const att = await attestor.signGuardianChange({
      customerId,
      wallet,
      oldGuardian,
      newGuardian,
      nonce: Number(nonce),
    });

    const tx = await guardianQueue.openRequest(
      att.personId,
      wallet,
      oldGuardian,
      newGuardian,
      att.deadline,
      att.signature
    );
    const rcpt = await tx.wait();

    const ev = rcpt.logs
      .map((l) => { try { return guardianQueue.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "RequestOpened");

    ok(res, {
      requestId: ev ? Number(ev.args.requestId) : null,
      executableAt: ev ? Number(ev.args.executableAt) : null,
      txHash: tx.hash,
    });
  } catch (e) { fail(res, e); }
});

app.post("/api/guardian-replace/cancel", async (req, res) => {
  if (!guardianQueue) return res.status(404).json({ ok: false, error: "No guardian queue deployed." });
  try {
    const { requestId } = req.body;
    const tx = await guardianQueue.cancel(requestId);
    await tx.wait();
    ok(res, { txHash: tx.hash });
  } catch (e) { fail(res, e); }
});

app.post("/api/guardian-replace/finalize", async (req, res) => {
  if (!guardianQueue) return res.status(404).json({ ok: false, error: "No guardian queue deployed." });
  try {
    const { requestId } = req.body;
    const tx = await guardianQueue.finalize(requestId);
    await tx.wait();
    ok(res, { txHash: tx.hash });
  } catch (e) { fail(res, e); }
});

app.get("/api/guardian-replace/state/:requestId", async (req, res) => {
  if (!guardianQueue) return res.status(404).json({ ok: false, error: "No guardian queue deployed." });
  try {
    const requestId = Number(req.params.requestId);
    const reqData = await guardianQueue.getRequest(requestId);
    const timeRem = await guardianQueue.timeRemaining(requestId);
    ok(res, {
      personId: reqData.personId,
      wallet: reqData.wallet,
      oldGuardian: reqData.oldGuardian,
      newGuardian: reqData.newGuardian,
      openedAt: Number(reqData.openedAt),
      executableAt: Number(reqData.executableAt),
      cancelled: reqData.cancelled,
      finalized: reqData.finalized,
      timeRemaining: Number(timeRem),
    });
  } catch (e) { fail(res, e); }
});

// ---- 5b. vault fallback receiver endpoints ----------------------------------
app.get("/api/vault/fallback-receiver", async (req, res) => {
  if (!vault) return res.status(404).json({ ok: false, error: "No vault deployed." });
  try {
    const address = await vault.fallbackReceiver();
    const active = await registry.isActive(address);
    ok(res, { address, active });
  } catch (e) { fail(res, e); }
});

app.post("/api/vault/fallback-receiver", async (req, res) => {
  if (!vault) return res.status(404).json({ ok: false, error: "No vault deployed." });
  try {
    const { address } = req.body;
    if (!ethers.isAddress(address) || address === ethers.ZeroAddress) {
      throw new Error("Invalid receiver address");
    }
    const tx = await vault.setFallbackReceiver(address);
    await tx.wait();
    ok(res, { txHash: tx.hash });
  } catch (e) { fail(res, e); }
});

app.get("/api/vault/repayment-failures", async (req, res) => {
  if (!vault) return res.status(404).json({ ok: false, error: "No vault deployed." });
  try {
    const filter = vault.filters.RepaymentFailed();
    const events = await vault.queryFilter(filter, 0, "latest");
    const list = [];
    for (const e of events) {
      const claimId = Number(e.args.claimId);
      const owedNote = ethers.formatUnits(e.args.owedNote, 6);
      const reason = e.args.reason;
      
      let receiver = ethers.ZeroAddress;
      try {
        receiver = await vault.fallbackReceiver({ blockTag: e.blockNumber });
      } catch (err) {
        receiver = await vault.fallbackReceiver();
      }
      
      list.push({
        claimId,
        owedNote,
        reason,
        receiver,
        txHash: e.transactionHash,
        blockNumber: e.blockNumber,
      });
    }
    ok(res, { failures: list });
  } catch (e) { fail(res, e); }
});

// ---- 5c. list guardian replacement requests ---------------------------------
app.get("/api/guardian-replace/requests", async (req, res) => {
  if (!guardianQueue) return res.status(404).json({ ok: false, error: "No guardian queue deployed." });
  try {
    const count = Number(await guardianQueue.requestCount());
    const list = [];
    for (let i = 0; i < count; i++) {
      const reqData = await guardianQueue.getRequest(i);
      const timeRemaining = Number(await guardianQueue.timeRemaining(i));
      list.push({
        requestId: i,
        personId: reqData.personId,
        wallet: reqData.wallet,
        oldGuardian: reqData.oldGuardian,
        newGuardian: reqData.newGuardian,
        openedAt: Number(reqData.openedAt),
        executableAt: Number(reqData.executableAt),
        cancelled: reqData.cancelled,
        finalized: reqData.finalized,
        timeRemaining,
      });
    }
    ok(res, { requests: list });
  } catch (e) { fail(res, e); }
});

app.get("/api/config", (_req, res) => {
  ok(res, {
    wallets: DEMO_WALLETS,
    // The UI used to hardcode "30 seconds" in its copy, which silently lied
    // whenever CURE_WINDOW differed. Serve the deployed value instead.
    cureWindow: D.cureWindow,
    chainId: D.chainId,
    token: D.token,
    localMode: LOCAL_MODE,
    // Whether this backend can co-sign as the guardian, or the caller must
    // supply the signature themselves.
    guardian: { address: DEMO_WALLETS.G, canCoSign: guardianKey() !== null },
    advance: vault
      ? {
          enabled: true,
          vault: D.vault,
          ltvBps: D.advanceLtvBps,
          feeBps: D.advanceFeeBps,
          stableSymbol: "dUSDC",
        }
      : { enabled: false },
  });
});

// ---- state for the UI -------------------------------------------------------
app.get("/api/state", async (req, res) => {
  try {
    const { wallets, customerId } = req.query;
    const list = (wallets || "").split(",").filter(Boolean);
    const out = {};
    for (const w of list) {
      out[w] = {
        balance: ethers.formatUnits(await token.balanceOf(w), 6),
        revoked: await registry.revoked(w),
        active: await registry.isActive(w),
        stable: stable
          ? ethers.formatUnits(await stable.balanceOf(w), Number(await stable.decimals()))
          : null,
      };
    }
    let liveGuardian = null;
    let activeGuardianRequest = null;
    if (customerId) {
      const personId = personIdOf(customerId);
      liveGuardian = await registry.guardianOf(personId);

      if (guardianQueue) {
        const hasActive = await guardianQueue.hasActiveRequest(personId);
        if (hasActive) {
          const requestId = Number(await guardianQueue.activeRequestOf(personId));
          const reqData = await guardianQueue.getRequest(requestId);
          const timeRemaining = Number(await guardianQueue.timeRemaining(requestId));
          activeGuardianRequest = {
            requestId,
            personId: reqData.personId,
            wallet: reqData.wallet,
            oldGuardian: reqData.oldGuardian,
            newGuardian: reqData.newGuardian,
            openedAt: Number(reqData.openedAt),
            executableAt: Number(reqData.executableAt),
            cancelled: reqData.cancelled,
            finalized: reqData.finalized,
            timeRemaining,
          };
        }
      }
    }
    ok(res, { wallets: out, contracts: D, claimCount: Number(await queue.claimCount()), liveGuardian, activeGuardianRequest });
  } catch (e) { fail(res, e); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`  http://localhost:${PORT}`));
