/**
 * THE LAST OPEN QUESTION. Run this before you write the demo script.
 *
 *   node scripts/freeze-scope-test.js
 *
 * Rebind's step 5 revokes the OLD wallet after recovery. That only works if
 * update_status is scoped per-WALLET. If Cleanverse scopes it per-customerId,
 * revoking the old binding kills the new one too and the design breaks.
 *
 * PASS  -> A frozen, B active. Ship as designed.
 * FAIL  -> both frozen. Fall back to enforcing revocation only in
 *          BindingRegistry (contracts already support this — just skip the
 *          Cleanverse updateStatus call in /api/revoke), and tell the judges
 *          you found a platform limitation. That reads as rigour.
 */
require("dotenv").config();
const crypto = require("crypto");
const cv = require("../backend/cleanverse");

const rand = () => "0x" + crypto.randomBytes(20).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 3_000;
const TIMEOUT_MS = 60_000;

function statusFrom(response) {
  // API versions have returned the record directly and nested it below `apass`.
  // Keep the raw response in the final diagnostic if neither shape applies.
  const data = response?.data;
  return data?.status ?? data?.apass?.status ?? data?.item?.status ?? null;
}

async function readStatuses(A, B) {
  const [a, b] = await Promise.all([
    cv.queryApass({ address: A }),
    cv.queryApass({ address: B }),
  ]);
  return {
    a: statusFrom(a), b: statusFrom(b),
    rawA: a, rawB: b,
  };
}

async function waitForStatuses(A, B, predicate, label) {
  const endsAt = Date.now() + TIMEOUT_MS;
  let latest;
  do {
    latest = await readStatuses(A, B);
    console.log(`   ${label}: A=${latest.a ?? "unknown"}, B=${latest.b ?? "unknown"}`);
    if (predicate(latest)) return latest;
    if (Date.now() + POLL_MS <= endsAt) await sleep(POLL_MS);
  } while (Date.now() < endsAt);
  return latest;
}

function assertSuccess(response, action) {
  if (String(response?.code) !== "0000") {
    throw new Error(`${action} failed: ${response?.code ?? "no code"} ${response?.message ?? ""}`.trim());
  }
}

async function main() {
  const CID = "FRZ" + Date.now();          // >=12 chars, alphanumeric only
  const A = rand();
  const B = rand();

  console.log(`customerId ${CID}\nwallet A   ${A}\nwallet B   ${B}\n`);

  try {
    console.log("1. binding wallet A ...");
    let r = await cv.generateApass({ customerId: CID, address: A });
    assertSuccess(r, "binding wallet A");
    console.log("   code", r.code, "record", r.data?.cvRecordId);

    console.log("2. binding wallet B to the SAME customerId (override) ...");
    r = await cv.generateApass({ customerId: CID, address: B, override: true });
    assertSuccess(r, "binding wallet B");
    console.log("   code", r.code, "record", r.data?.cvRecordId);

    const wallets = await cv.walletsForCustomer(CID);
    console.log("3. wallets under this customerId:", wallets);
    if (!wallets.includes(A.toLowerCase()) || !wallets.includes(B.toLowerCase())) {
      throw new Error("Cleanverse did not return both bindings for the customerId; refusing to test an ambiguous setup.");
    }

    const before = await waitForStatuses(A, B, ({ a, b }) => String(a) === "1" && String(b) === "1", "waiting for both bindings to become active");
    if (String(before.a) !== "1" || String(before.b) !== "1") {
      throw new Error("Bindings never reached active status. Raw query responses follow:\n" + JSON.stringify(before));
    }

    console.log("\n4. freezing ONLY wallet A ...");
    r = await cv.updateStatus({ customerId: CID, address: A, status: 2, reason: "scope test" });
    assertSuccess(r, "freezing wallet A");
    console.log("   code", r.code, "tx", r.data?.txHash);

    const after = await waitForStatuses(
      A, B,
      ({ a, b }) => String(a) === "2" && (String(b) === "1" || String(b) === "2"),
      "waiting for freeze to settle"
    );
    const sa = after.a;
    const sb = after.b;

  console.log(`\n   A status = ${sa}   (2 = frozen)`);
  console.log(`   B status = ${sb}   (1 = active)`);

  const pass = String(sa) === "2" && String(sb) === "1";

    console.log("\n" + "=".repeat(58));
    if (pass) {
      console.log("PASS - freeze is PER-WALLET. Ship Rebind as designed.");
    } else if (String(sa) === "2" && String(sb) === "2") {
      console.log("FAIL - freeze is PER-IDENTITY. Both wallets died.");
      console.log("       Use the registry-only fallback: in backend/server.js");
      console.log("       /api/revoke, skip cv.updateStatus and call only");
      console.log("       registry.revokeWallet(). Mention it on stage.");
    } else {
      console.log(`INCONCLUSIVE after ${TIMEOUT_MS / 1000}s - A=${sa} B=${sb}.`);
      console.log("Raw responses:", JSON.stringify({ A: after.rawA, B: after.rawB }, null, 2));
    }
    console.log("=".repeat(58));
  } finally {
    // Do not leave the freshly created test wallet frozen, even if the probe fails.
    try {
      const r = await cv.updateStatus({ customerId: CID, address: A, status: 1 });
      console.log("\nCleanup activate A:", r.code, r.data?.txHash || r.message || "");
    } catch (e) {
      console.warn("Cleanup could not reactivate wallet A:", e.message);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
