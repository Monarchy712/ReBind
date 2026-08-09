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
/* The frontend is a Vite/React app. In production it is a static bundle in
   frontend/dist, which this server hands out so `npm run server:local` still
   gives you the whole thing on one port. During development you would instead
   run `npm run web` (Vite on :5173) and let its proxy forward /api here.
   Serving the un-built source directory would only ever hand the browser a
   bare index.html pointing at /src/main.jsx, so say so plainly instead. */
const WEB_DIST = path.join(__dirname, "..", "frontend", "dist");
if (fs.existsSync(path.join(WEB_DIST, "index.html"))) {
  app.use(express.static(WEB_DIST));
} else {
  console.warn(
    "  frontend  NOT BUILT — run `npm run web:build` (or use `npm run web` for the dev server)",
  );
  app.get("/", (_req, res) =>
    res
      .status(503)
      .type("html")
      .send(
        "<pre style='font:14px ui-monospace;padding:40px;line-height:1.7'>" +
          "The frontend has not been built yet.\n\n" +
          "  npm run web:build     build it once, then reload this page\n" +
          "  npm run web           or run the Vite dev server on :5173\n\n" +
          "The API on this port is running normally.</pre>",
      ),
  );
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

/**
 * A deadline the CHAIN will accept, not one the wall clock agrees with.
 *
 * The local demo node fast-forwards time (evm_increaseTime) every time the
 * challenge window is skipped, so its block timestamp drifts permanently ahead
 * of real time — an hour or more after a few runs. A deadline computed from
 * Date.now() is then already in the past on arrival, and the transaction
 * reverts with AuthorizationExpired even though nothing is actually expired.
 * Anchor to whichever clock is further ahead.
 */
async function chainDeadline(seconds) {
  const now = Math.floor(Date.now() / 1000);
  let blockTime = 0;
  try { blockTime = Number((await provider.getBlock("latest"))?.timestamp || 0); } catch { /* fall back to wall clock */ }
  return Math.max(now, blockTime) + seconds;
}

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

/**
 * Public RPC endpoints fail in ways ethers cannot describe usefully. A rate
 * limit or a transient node error arrives as a non-standard JSON-RPC shape and
 * surfaces as "could not coalesce error", which reached the trace log verbatim
 * during a Base Sepolia run and tells the reader nothing — least of all that
 * the transaction may well have landed.
 */
function humaniseRpcError(e) {
  const raw = e?.shortMessage || e?.message || String(e);
  if (/could not coalesce error/i.test(raw) || e?.code === "UNKNOWN_ERROR") {
    return "The RPC endpoint returned an error it could not describe — usually rate limiting on a public node. " +
           "The transaction may still have been mined; re-read the claim before retrying.";
  }
  if (/timeout|ETIMEDOUT|ECONNRESET|socket hang up/i.test(raw)) {
    return "The RPC endpoint timed out. The transaction may still have been mined; re-read the claim before retrying.";
  }
  return raw;
}

const fail = (res, e) => {
  console.error(e);
  const decoded = decodeRevert(e);
  res.status(400).json({ ok: false, error: decoded || humaniseRpcError(e), proof: e.proof });
};

// ---- 1. register a person + wallet -----------------------------------------
app.post("/api/register", async (req, res) => {
  try {
    const { customerId, address, override, guardianAddress } = req.body;
    requireAddress(address, "address");
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
    requireAddress(to, "to");
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      throw new Error(`amount must be a positive number, got ${JSON.stringify(amount)}`);
    }
    const tx = await token.mint(to, ethers.parseUnits(String(amount), 6));
    await tx.wait();
    ok(res, { txHash: tx.hash, balance: (await token.balanceOf(to)).toString() });
  } catch (e) { fail(res, e); }
});

/**
 * Reject anything that is not an address before it reaches ethers.
 *
 * Without this, a typo in the recovery wizard's address field came back as
 * "network does not support ENS" — ethers assumes a non-address string is an
 * ENS name and fails on a chain that has no resolver. That message tells the
 * person who mistyped nothing at all about what went wrong.
 */
function requireAddress(value, label) {
  if (!value || typeof value !== "string" || !ethers.isAddress(value)) {
    throw new Error(`${label} is not a valid address: ${JSON.stringify(value)}`);
  }
  return value;
}

// ---- 3. pre-flight check (the blocked-theft beat) ---------------------------
app.post("/api/check", async (req, res) => {
  try {
    const { from, to, amount } = req.body;
    requireAddress(from, "from");
    requireAddress(to, "to");
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
    requireAddress(oldWallet, "oldWallet");
    requireAddress(newWallet, "newWallet");

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
      //
      // The co-signature must come from the CURRENT guardianOf. After a guardian
      // replacement the old key is obsolete and openClaim reverts with
      // BadGuardianAttestation — so co-sign with whichever held key matches the
      // live guardian (GUARDIAN_PK, DEMO_NEW_GUARDIAN_PK, or a local demo
      // wallet), and fail with a fix instead of a raw revert when there is none.
      let gKey = guardianPrivateKey ? normalizePrivateKey(guardianPrivateKey) : null;
      if (!gKey) {
        const liveGuardian = await registry.guardianOf(att.personId);
        const match = guardianKeyFor(liveGuardian, sessionOf(req));
        if (!match) {
          if (liveGuardian === ethers.ZeroAddress) {
            throw new Error(
              "No guardian is pinned for this identity. It was never registered, or the customerId is wrong."
            );
          }
          const held = guardianKeys(sessionOf(req)).map((k) => k.address).join(", ") || "(none held)";
          throw new Error(
            `The live guardian is ${liveGuardian}, but this backend can only co-sign as ${held}. ` +
            `A claim must be co-signed by the CURRENT guardian — after a replacement the old key is ` +
            `obsolete. Set DEMO_NEW_GUARDIAN_PK to the replacement guardian's key and redeploy ` +
            `(local mode already knows it), or rotate the guardian back to a key this backend holds.`
          );
        }
        gKey = match.privateKey;
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
    let privKey = guardianPrivateKey ? normalizePrivateKey(guardianPrivateKey) : null;
    if (!privKey) {
      const liveGuardian = await registry.guardianOf(personIdOf(customerId));
      const match = guardianKeyFor(liveGuardian, sessionOf(req));
      if (!match) {
        const held = guardianKeys(sessionOf(req)).map((k) => k.address).join(", ") || "(none held)";
        throw new Error(
          `This backend can only co-sign as ${held}, but the live guardian is ${liveGuardian}. ` +
          `Pass guardianPrivateKey for the CURRENT guardian, or set DEMO_NEW_GUARDIAN_PK and redeploy.`
        );
      }
      privKey = match.privateKey;
    }
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
    const signer = borrowerSigner(sessionOf(req));
    if (!signer) {
      throw new Error(
        "No borrower key available. The advance must be drawn by the claim's new wallet — " +
        "set DEMO_BORROWER_PK, run a rotating demo session, or run the local demo where the " +
        "wallets are disposable."
      );
    }

    const id = Number(req.body.claimId);

    // Use the gasless path: the borrower signs, the issuer key relays. A wallet
    // in the middle of recovering an asset may well hold no gas, so this is the
    // realistic flow rather than a convenience.
    const deadline = await chainDeadline(3600);
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
      // Order matters. "executed" has to be tested before the window, or a
      // second click on Recover reports "wait 0 more seconds" — a settled claim
      // has no time remaining, so the window branch answers for it and hides
      // the real reason.
      if (c.executed) throw new Error("This claim has already been executed — the asset has moved.");
      if (c.cancelled) throw new Error("Claim was rejected during issuer review.");
      if (!c.issuerApproved) throw new Error("Claim still needs issuer approval.");
      const remaining = Number(await queue.timeRemaining(id));
      throw new Error(
        remaining > 0
          ? `Challenge window is still active. Wait ${remaining} more second(s).`
          : "The claim is not executable yet — the chain has not registered the window as elapsed. Try again in a moment."
      );
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
  ? { A: demoAccount(5), B: demoAccount(6), X: demoAccount(7), G: demoAccount(8), G2: demoAccount(9) }
  : null;

/* ---------------------------------------------------- rotating demo sessions
 * A BindingRegistry binding is immutable — a wallet belongs to one person,
 * ever, and revoked[] is never cleared. That is a deliberate property of the
 * asset, not an oversight, so the same three addresses can only ever run the
 * recovery story ONCE. Re-running it used to mean redeploying every contract
 * and re-registering the token with Cleanverse.
 *
 * So a reset does not undo anything. It moves to a new person on new
 * addresses, derived from DEMO_MNEMONIC at a session index the browser picks:
 *
 *     m/44'/60'/{session}'/0/{0..4}   ->   A, B, X, G, G2
 *
 * Three consequences worth knowing:
 *
 *   - It costs nothing. No demo wallet ever sends a transaction — the theft
 *     beat is a staticcall, the advance is an EIP-712 authorisation the issuer
 *     relays, and every state change is sent by the issuer or attestor. Fresh
 *     addresses therefore need no gas, on any network.
 *   - The backend stays stateless. The session is derived, not stored, so it
 *     survives a restart and works across multiple backend instances.
 *   - Two browsers can demo at once. Sessions differ in both wallets and
 *     personId, and claims/advances/guardian requests are all keyed by one or
 *     the other, so nothing collides.
 *
 * Session 0 means "the configured session" — the .env DEMO_WALLET_* addresses
 * live, or Hardhat accounts 5-9 locally — which is exactly the behaviour that
 * existed before sessions did.
 */
const DEMO_MNEMONIC = process.env.DEMO_MNEMONIC || (LOCAL_MODE ? HARDHAT_MNEMONIC : null);

/** Hardened path components are capped at 2^31-1, so sessions are too. */
const MAX_SESSION = 2 ** 31 - 1;

/**
 * Read a session index off a request. The browser sends it as a header on
 * every call; ?session= is accepted too so the API stays usable from curl.
 *
 * A session index chooses a derivation path, so it is attacker-controlled
 * input to key generation and is validated as strictly as one: an integer in
 * range, or the configured session. Anything malformed is rejected rather than
 * coerced, because coercing it silently would hand back a DIFFERENT person's
 * wallets than the caller believes it is using.
 */
function sessionOf(req) {
  const raw = req.get?.("X-Rebind-Session") ?? req.query?.session;
  if (raw === undefined || raw === null || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_SESSION) {
    throw new Error(`Invalid demo session ${JSON.stringify(raw)}: expected an integer in 0..${MAX_SESSION}.`);
  }
  return n;
}

const sessionCache = new Map();

/**
 * The five wallets of a derived session, as signers.
 *
 * DEMO_MNEMONIC must be a phrase of its own and never the deployer's, or a
 * caller could pick the session index whose path lands on an institutional
 * address and ask this backend to act as it.
 */
function sessionWallets(session) {
  if (!DEMO_MNEMONIC) {
    throw new Error(
      "Rotating demo sessions need DEMO_MNEMONIC set to a BIP-39 phrase of its own (not the " +
      "deployer's). Set it, or use session 0 with DEMO_WALLET_A/B/X configured."
    );
  }
  if (sessionCache.has(session)) return sessionCache.get(session);
  const at = (i) =>
    ethers.HDNodeWallet.fromPhrase(DEMO_MNEMONIC, undefined, `m/44'/60'/${session}'/0/${i}`);
  const w = { A: at(0), B: at(1), X: at(2), G: at(3), G2: at(4) };
  sessionCache.set(session, w);
  return w;
}

/**
 * The address of whichever key guardianKey() will actually co-sign with.
 *
 * This has to lead the guardian address we advertise, because the two used to
 * disagree: G fell back to the generated local wallet while guardianKey()
 * prefers GUARDIAN_PK. Local mode with a GUARDIAN_PK in .env therefore
 * registered one guardian, pinned it in the registry, and then co-signed
 * claims with a different key — openClaim reverted with
 * BadGuardianAttestation and the demo could never get past the claim step.
 */
const guardianSignerAddress = (() => {
  const k = guardianKey();
  if (!k) return null;
  try { return new ethers.Wallet(k).address; } catch { return null; }
})();

/**
 * The configured session (session 0): .env addresses live, Hardhat accounts
 * locally.
 *
 * This used to run at module scope and throw on a misconfiguration, which
 * stopped the server booting. It cannot any more: a live deployment that only
 * ever uses rotating sessions has no DEMO_WALLET_* to offer, and refusing to
 * start over an unused session would take the whole demo down. The checks are
 * unchanged, they just run on first use of session 0 and fail that request.
 */
let configuredWalletsMemo;
const configuredWallets = () => (configuredWalletsMemo ??= buildConfiguredWallets());

/** The wallets for a session: 0 is configured, anything else is derived. */
function walletsFor(session) {
  if (!session) return configuredWallets();
  const w = sessionWallets(session);
  const wallets = { A: w.A.address, B: w.B.address, X: w.X.address, G: w.G.address, G2: w.G2.address };

  // The same collision check buildConfiguredWallets does for .env addresses.
  // It should be unreachable — DEMO_MNEMONIC is supposed to be a phrase of its
  // own — but the session index is chosen by the caller, so this is the one
  // place a request could ask us to sign as an institution. Being unreachable
  // is a reason to assert it, not to omit it.
  const reserved = new Map([
    [issuer.address.toLowerCase(), "issuer"],
    [attestorWallet.address.toLowerCase(), "attestor"],
    ...(D.vault ? [[D.vault.toLowerCase(), "vault"]] : []),
  ]);
  for (const [name, addr] of Object.entries(wallets)) {
    const clash = reserved.get(addr.toLowerCase());
    if (clash) {
      throw new Error(
        `Demo session ${session} derives wallet ${name} onto the ${clash} address (${addr}). ` +
        `DEMO_MNEMONIC must be a phrase that shares no keys with the deployer or attestor.`
      );
    }
  }
  return wallets;
}

function buildConfiguredWallets() {
  // Local mode derives the wallets from the Hardhat mnemonic, so they are
  // pre-funded, disposable, and can never collide with anything else on the
  // fresh chain the deploy script writes to.
  if (LOCAL_MODE) {
    return {
      A: localDemoWallets.A.address,
      B: localDemoWallets.B.address,
      X: localDemoWallets.X.address,
      // An explicit DEMO_WALLET_G still wins — that operator is nominating a
      // guardian they will supply signatures for out of band, and canCoSign
      // below reports honestly when we cannot sign for it.
      G: process.env.DEMO_WALLET_G || localDemoWallets.G.address,
      // Replacement-guardian candidate generated at deploy time and bound to
      // the demo customerId by the register beat, so the guardian-replacement
      // form can autofill a verified, non-colliding address.
      G2: D.newGuardian || localDemoWallets.G2.address,
    };
  }

  // Live mode: the demo wallets USED to fall back to hardcoded addresses, one
  // of which was the issuer's own address. deploy.js binds the fallback
  // receiver (the issuer by default) as an institutional wallet, so registering
  // that address as Alice immediately failed on-chain with "already bound to a
  // different customer identity" — on every fresh deployment. Require explicit,
  // never-before-bound addresses instead of guessing one.
  const missing = ["DEMO_WALLET_A", "DEMO_WALLET_B", "DEMO_WALLET_X"].filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Live mode needs fresh demo wallets: set ${missing.join(", ")} in .env. ` +
      `They must be addresses the registry has never bound — in particular NOT the issuer ` +
      `(${issuer.address}) or the attestor (${attestorWallet.address}), which the deploy ` +
      `script binds as institutions.`
    );
  }

  const wallets = {
    A: process.env.DEMO_WALLET_A,
    B: process.env.DEMO_WALLET_B,
    X: process.env.DEMO_WALLET_X,
    G: process.env.DEMO_WALLET_G || guardianSignerAddress || null,
    // Replacement-guardian candidate generated at deploy time (see deploy.js).
    // Null until a deployment that wrote newGuardian is used.
    G2: D.newGuardian || null,
  };

  // The deploy script binds the issuer (fallback receiver) and the vault as
  // institutional wallets. A demo wallet that IS one of those can never be
  // registered as a person — the registry rejects it as "already bound".
  // D.issuer is the address the CURRENT deployment actually bound, which can
  // differ from issuer.address if DEPLOYER_PK changed after deploying.
  const taken = [
    ["issuer (DEPLOYER_PK)", issuer.address],
    ...(D.issuer ? [["issuer (deployment)", D.issuer]] : []),
    ["attestor", attestorWallet.address],
    ...(D.vault ? [["vault", D.vault]] : []),
  ];
  for (const [name, addr] of taken) {
    for (const [w, demoAddr] of Object.entries(wallets)) {
      if (demoAddr && demoAddr.toLowerCase() === addr.toLowerCase()) {
        throw new Error(
          `DEMO_WALLET_${w} (${demoAddr}) is the on-chain ${name}, which the deploy script binds ` +
          `as an institution. Use a fresh address, or set FALLBACK_RECEIVER in .env to a dedicated ` +
          `address so the issuer is not bound.`
        );
      }
    }
  }

  // If a borrower key is configured for the bridge advance, it MUST belong to
  // wallet B — the vault only accepts a draw signed by the claim's own new
  // wallet. A mismatch makes the draw revert with BadAuthorization.
  if (process.env.DEMO_BORROWER_PK) {
    const borrowerAddr = new ethers.Wallet(normalizePrivateKey(process.env.DEMO_BORROWER_PK)).address;
    if (borrowerAddr.toLowerCase() !== wallets.B.toLowerCase()) {
      throw new Error(
        `DEMO_BORROWER_PK (${borrowerAddr}) does not match DEMO_WALLET_B (${wallets.B}). ` +
        `The advance can only be drawn by the claim's new wallet, so the borrower key must BE wallet B.`
      );
    }
  }

  // If both DEMO_WALLET_G and GUARDIAN_PK are set they must agree, or the
  // registered guardian and the co-signing key diverge and every claim reverts
  // with BadGuardianAttestation.
  if (wallets.G && guardianSignerAddress && wallets.G.toLowerCase() !== guardianSignerAddress.toLowerCase()) {
    throw new Error(
      `DEMO_WALLET_G (${wallets.G}) does not match GUARDIAN_PK (${guardianSignerAddress}). ` +
      `Registration pins DEMO_WALLET_G as the guardian, but claims are co-signed with GUARDIAN_PK — ` +
      `the two must be the same address.`
    );
  }

  return wallets;
}

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

/**
 * Every demo guardian key this backend can co-sign with. The claim flow picks
 * whichever one matches the CURRENT live guardian, so a guardian replacement
 * keeps the demo working instead of reverting with BadGuardianAttestation.
 * Local mode derives both the original (G) and the replacement candidate (G2)
 * from the Hardhat mnemonic; live mode takes them from GUARDIAN_PK and
 * DEMO_NEW_GUARDIAN_PK.
 */
function guardianKeys(session = 0) {
  const keys = [];
  const push = (pk, label) => {
    if (!pk) return;
    const privateKey = normalizePrivateKey(pk);
    keys.push({ label, privateKey, address: new ethers.Wallet(privateKey).address });
  };
  // A rotating session brings its own guardian pair, and they lead: the
  // registry pins THIS session's G at registration, so an env key from another
  // session would only ever produce BadGuardianAttestation.
  if (session) {
    const w = sessionWallets(session);
    keys.push({ label: `session ${session} wallet G`, privateKey: w.G.privateKey, address: w.G.address });
    keys.push({ label: `session ${session} wallet G2`, privateKey: w.G2.privateKey, address: w.G2.address });
    return keys;
  }
  push(process.env.GUARDIAN_PK, "GUARDIAN_PK");
  push(process.env.DEMO_NEW_GUARDIAN_PK, "DEMO_NEW_GUARDIAN_PK");
  if (localDemoWallets) {
    keys.push({
      label: "local wallet G",
      privateKey: localDemoWallets.G.privateKey,
      address: localDemoWallets.G.address,
    });
    keys.push({
      label: "local wallet G2",
      privateKey: localDemoWallets.G2.privateKey,
      address: localDemoWallets.G2.address,
    });
  }
  return keys;
}

/** The held key whose address is the given live guardian, or null. */
function guardianKeyFor(liveGuardian, session = 0) {
  if (!liveGuardian) return null;
  const want = liveGuardian.toLowerCase();
  return guardianKeys(session).find((k) => k.address.toLowerCase() === want) || null;
}

/**
 * The signer that can draw an advance, or null if we hold no borrower key.
 *
 * On a rotating session this is never null: wallet B is derived, so the
 * backend holds its key by construction. That closes a real gap — off a local
 * chain the advance beat previously needed DEMO_BORROWER_PK pinned by hand to
 * whatever DEMO_WALLET_B was, and was simply dead without it.
 */
function borrowerSigner(session = 0) {
  if (session) return sessionWallets(session).B.connect(provider);
  if (process.env.DEMO_BORROWER_PK) {
    return new ethers.Wallet(normalizePrivateKey(process.env.DEMO_BORROWER_PK), provider);
  }
  if (localDemoWallets && configuredWallets().B === localDemoWallets.B.address) {
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
    const { customerId, wallet, oldGuardian, newGuardian, allowUnsignable } = req.body;

    /* Installing a guardian this backend holds no key for is a one-way door:
       the replacement succeeds, and every later claim reverts with
       BadGuardianAttestation because a claim must carry the CURRENT guardian's
       co-signature. That is recoverable only by replacing the guardian again,
       which is not obvious at the moment it breaks — so refuse here, where the
       fix is cheap, rather than at claim time.

       A real deployment has a third-party guardian signing on their own device
       and passing `guardianSignature` to /api/claim; that case is legitimate,
       so it can opt in with allowUnsignable. */
    if (!allowUnsignable && newGuardian && !guardianKeyFor(newGuardian, sessionOf(req))) {
      throw new Error(
        `This backend holds no key for ${newGuardian}, so it could never co-sign a ` +
        `recovery claim for that guardian — every claim after this replacement would ` +
        `fail. Choose one of: ${guardianKeys(sessionOf(req)).map((k) => k.address).join(", ")}. ` +
        `Pass allowUnsignable:true only if the guardian will sign out of band.`
      );
    }

    const nonce = await guardianQueue.nonces(wallet);

    // Same chain-clock drift as everywhere else: on the local node the block
    // timestamp runs ahead of real time, so anchor the deadline to the chain.
    const att = await attestor.signGuardianChange({
      customerId,
      wallet,
      oldGuardian,
      newGuardian,
      nonce: Number(nonce),
      deadline: await chainDeadline(86400),
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

app.get("/api/config", (req, res) => {
  try {
  const session = sessionOf(req);
  const DEMO_WALLETS = walletsFor(session);
  ok(res, {
    session,
    // Whether this backend can hand out a fresh session at all. The UI hides
    // its reset control rather than offering a button that can only fail.
    canReset: DEMO_MNEMONIC !== null,
    wallets: DEMO_WALLETS,
    // The UI used to hardcode "30 seconds" in its copy, which silently lied
    // whenever CURE_WINDOW differed. Serve the deployed value instead.
    cureWindow: D.cureWindow,
    chainId: D.chainId,
    token: D.token,
    localMode: LOCAL_MODE,
    // Whether this backend can co-sign as the guardian, or the caller must
    // supply the signature themselves.
    // canCoSign means "this backend can produce the co-signature for THAT
    // address" — not merely "some guardian key exists". Reporting the latter
    // is what let a mismatched pair reach the claim step and revert on-chain.
    guardian: {
      address: DEMO_WALLETS.G,
      // True when we hold a key for the guardian we advertise. Checked against
      // the whole keyring, not just guardianKey(): local mode nominates its own
      // generated wallet G while guardianKey() prefers GUARDIAN_PK, so a
      // single-key comparison reported "signature required" for a guardian the
      // backend could in fact sign for.
      canCoSign: DEMO_WALLETS.G != null && guardianKeyFor(DEMO_WALLETS.G, session) !== null,
      // Every address this backend can actually co-sign as. After a guardian
      // replacement the claim flow uses whichever matches the CURRENT guardian.
      keys: guardianKeys(session).map((k) => k.address),
    },
    advance: vault
      ? {
          enabled: true,
          vault: D.vault,
          ltvBps: D.advanceLtvBps,
          feeBps: D.advanceFeeBps,
          stableSymbol: "dUSDC",
          // Whether this backend can sign as the borrower. Only wallet B can
          // authorise an advance against its own claim, and off a local chain
          // we hold that key only if DEMO_BORROWER_PK is set. Saying so here
          // lets the UI explain the gap instead of offering a button whose
          // only possible outcome is "No borrower key available".
          canDraw: borrowerSigner(session) !== null,
        }
      : { enabled: false },
  });
  } catch (e) { fail(res, e); }
});

/**
 * Hand out a fresh demo session.
 *
 * There is nothing to tear down — see the note above sessionWallets. The new
 * session's wallets have never been bound, so step 1 of the flow registers
 * them normally, and the previous session's frozen wallet, spent claim and
 * settled advance are simply left behind on-chain where they belong as
 * history. The only thing that genuinely accumulates is vault liquidity, so
 * this tops that up.
 *
 * The caller proposes the index rather than the server allocating one, which
 * is what keeps concurrent demos independent and this backend stateless.
 */
app.post("/api/reset", async (req, res) => {
  try {
    const session = sessionOf(req);
    if (!session) {
      throw new Error(
        "A reset needs a new session index. The browser picks one; a bare /api/reset with no " +
        "X-Rebind-Session header would just re-select the configured wallets, which are already spent."
      );
    }
    const wallets = walletsFor(session);

    // Every draw takes stable out of the vault and puts NOTE in, permanently.
    // Nothing in the flow ever puts the stable back, so enough sessions would
    // eventually leave a vault that quotes an advance it cannot fund — the
    // draw reverts mid-demo with nothing on screen explaining why. Top up
    // before that, not after.
    let toppedUp = null;
    if (vault && stable) {
      const decimals = Number(await stable.decimals());
      const available = await vault.availableLiquidity();
      const floor = ethers.parseUnits(process.env.ADVANCE_TOPUP_FLOOR || "5000", decimals);
      if (available < floor) {
        const amount = ethers.parseUnits(process.env.ADVANCE_TOPUP || "50000", decimals);
        // Only a stablecoin we deployed can be minted. Against a real one the
        // deployer has to hold the balance already, so say which it is.
        if (typeof stable.mint === "function") {
          try {
            await (await stable.mint(issuer.address, amount)).wait();
          } catch {
            /* not ours to mint — fall through to the balance we hold */
          }
        }
        const held = await stable.balanceOf(issuer.address);
        if (held < amount) {
          throw new Error(
            `Vault liquidity is down to ${ethers.formatUnits(available, decimals)} and the issuer holds ` +
            `only ${ethers.formatUnits(held, decimals)} to refill it with. Fund the issuer, or lower ` +
            `ADVANCE_TOPUP.`
          );
        }
        await (await stable.approve(D.vault, amount)).wait();
        await (await vault.depositLiquidity(amount)).wait();
        toppedUp = ethers.formatUnits(amount, decimals);
      }
    }

    ok(res, { session, wallets, toppedUp });
  } catch (e) { fail(res, e); }
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
const server = app.listen(PORT, () => console.log(`  http://localhost:${PORT}`));

/**
 * Say why the port could not be taken, and exit non-zero.
 *
 * Without this the failure was silent and deeply confusing: the listen error
 * went unhandled, the listening handle was released, the event loop drained,
 * and Node exited with status 0 — after the startup banner had already printed.
 * The server appeared to boot and then "just shut off", while a stale process
 * from an earlier session kept answering on the same port with whatever code it
 * had been started with.
 */
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(
      `\nRebind backend cannot start:\n\n` +
      `Port ${PORT} is already in use — most likely an older copy of this server ` +
      `that is still running and still serving its own build.\n\n` +
      `  Find it:  lsof -i :${PORT}      (or: ss -ltnp | grep :${PORT})\n` +
      `  Stop it:  kill <pid>\n` +
      `  Or run on another port:  PORT=3001 npm run server\n`
    );
  } else {
    console.error(`\nRebind backend cannot start:\n\n${e.message}\n`);
  }
  process.exit(1);
});
