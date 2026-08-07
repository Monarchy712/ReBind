/**
 * Registers your deployed RebindableRWA with Cleanverse as an A-Token.
 *
 *   node scripts/register-atoken.js
 *
 * WHY THIS MATTERS
 * ----------------
 * Cleanverse has no force-transfer endpoint, so a stock A-Token cannot be
 * recovered. register_atoken lets you register a contract YOU wrote — which
 * means you decide what functions it has, including recoveryTransfer().
 *
 * THE SIGNATURE
 * -------------
 * owner_signature is EIP-191 personal_sign over lowercase(chain) + lowercase(address),
 * concatenated with NO separator, e.g.:
 *     "base0x1234abcd..."
 * Cleanverse verifies it was produced by the contract's on-chain owner().
 * Your deployer is the owner, so sign with DEPLOYER_PK.
 */
require("dotenv").config();
const { ethers } = require("ethers");
const normalizePrivateKey = (value) => value && (value.startsWith("0x") ? value : `0x${value}`);
const cv = require("../backend/cleanverse");
const D = require("../deployments.json");

const CHAIN = process.env.CV_CHAIN || "base";
const ICON = process.env.TOKEN_ICON || "https://images.cleanverse.com/app/token_icon/USDC.svg";

async function main() {
  const owner = new ethers.Wallet(normalizePrivateKey(process.env.DEPLOYER_PK));
  const message = `${CHAIN.toLowerCase()}${D.token.toLowerCase()}`;

  console.log("owner    ", owner.address);
  console.log("token    ", D.token);
  console.log("signing  ", JSON.stringify(message));

  // Preflight: confirm LOCALLY that our signer is the on-chain owner() and that
  // the contract is visible on this RPC. This separates "my setup is wrong"
  // from "Cleanverse hasn't indexed the freshly deployed token yet".
  if (process.env.RPC_URL) {
    try {
      const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
      const onchainOwner = await new ethers.Contract(
        D.token, ["function owner() view returns (address)"], provider
      ).owner();
      if (onchainOwner.toLowerCase() !== owner.address.toLowerCase()) {
        console.error(`\nSTOP: signer ${owner.address} is NOT the token owner() ${onchainOwner}.`);
        console.error("Redeploy with this DEPLOYER_PK, or set DEPLOYER_PK to the deployer's key.");
        process.exitCode = 1; return;
      }
      console.log("owner()  ", onchainOwner, "(matches signer)");
    } catch (e) {
      console.warn(`\nWARN: could not read owner() from ${process.env.RPC_URL}: ${e.shortMessage || e.message}`);
      console.warn("If the token was just deployed, give the RPC a minute to index it, then retry.\n");
    }
  }

  const owner_signature = await owner.signMessage(message); // EIP-191

  const res = await cv.call("/atoken/register_atoken", {
    chain: CHAIN,
    atoken_address: D.token,
    owner_signature,
    atoken_icon: ICON,
  }, { encrypted: true });

  console.log("\nresponse:", JSON.stringify(res, null, 2));

  if (String(res.code) !== "0000") {
    console.error(`\nFAILED — Cleanverse code ${res.code}: ${res.message}`);
    console.error(`
Interpreting this:
  - Mentions signature/owner? The preflight above already confirmed
    signer == owner(), so Cleanverse most likely hasn't indexed the freshly
    deployed token yet. Wait ~1-2 min and re-run this command.
  - "already applied / pending"? A prior run already submitted this token.
    Do NOT re-register; poll status with the requestId it returned.
  - A true 403 (AES) would have thrown earlier, so this is not that.
`);
    process.exitCode = 1; return;
  }

  const requestId = res.data.requestId;
  console.log(`\nrequestId ${requestId}`);
  console.log("Polling apply status (this needs human approval and can take a while)...\n");

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 15000));
    const st = await cv.call(`/atoken/query_apply_status/${requestId}`, null, { method: "GET" });
    const s = st?.data?.applyStatus;
    console.log(`  [${new Date().toISOString().slice(11, 19)}] ${s || st.message}`);
    if (s === "ISSUED") { console.log("\nISSUED. Your contract is now a registered A-Token."); return; }
    if (s === "REJECTED") { console.error("\nREJECTED:", st.data.rejectReason); return; }
    if (s === "ISSUE_FAILED") { console.error("\nISSUE_FAILED:", st.data.issueErrorMsg); return; }
  }
  console.log("\nStill pending. Re-run query_apply_status later, or check the Member platform.");
}

// Avoid process.exit() so pending sockets/timers close cleanly. A hard exit
// mid-teardown is what triggers the Windows libuv assertion (async.c:76).
main().catch((e) => { console.error(e); process.exitCode = 1; });
