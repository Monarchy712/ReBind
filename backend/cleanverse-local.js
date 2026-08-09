/**
 * In-memory stand-in for the Cleanverse API, used by the local demo.
 *
 * WHY THIS EXISTS
 * ---------------
 * The real client in cleanverse.js talks to a hosted sandbox that needs API
 * credentials, and register_atoken has a human in the loop that can take hours.
 * That makes it impossible to run the demo — or iterate on the frontend —
 * offline, on a plane, or in CI.
 *
 * This module implements the exact surface of cleanverse.js against a Map, so
 * the whole flow (register -> mint -> blocked theft -> claim -> approve ->
 * execute) runs with no network and no credentials.
 *
 * IT IS NOT A SIMULATOR OF CLEANVERSE'S QUIRKS. The two documented surprises
 * that cleanverse.js exists to absorb — every response being HTTP 200, and a
 * frozen A-Pass surfacing as outer code "0002" instead of data.code === 3 —
 * are properties of the live service. Reproducing them here would only test
 * the stub. What this guarantees is that callers see the same SHAPES, so code
 * written against the stub keeps working against the real API.
 *
 * Enabled by DEMO_MODE=local. Never reachable in the default configuration.
 */

const CHAIN = process.env.CV_CHAIN || "local";

/* address (lowercased) -> { customerId, chain, status, cvRecordId, expirationTime }

   Persisted to disk between runs. On-chain bindings are deliberately
   immutable, so if this map is lost while the chain still holds the binding
   the identity becomes permanently unattestable: re-registering is refused by
   the registry, and every claim fails with "wallet does not have an A-Pass".
   Restarting the backend used to do exactly that and the only way out was a
   redeploy. The file lives next to deployments.json and is keyed by nothing —
   `npm run deploy:local` clears it, because a fresh chain means fresh
   identities. */
const fs = require("fs");
const path = require("path");
const STORE = path.join(__dirname, "..", ".cleanverse-local.json");

const bindings = new Map();
let recordSeq = 0;

(function restore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE, "utf8"));
    for (const [k, v] of Object.entries(raw.bindings || {})) bindings.set(k, v);
    recordSeq = raw.recordSeq || 0;
  } catch { /* no store yet, or unreadable — start empty */ }
})();

function persist() {
  try {
    fs.writeFileSync(STORE, JSON.stringify({
      bindings: Object.fromEntries(bindings),
      recordSeq,
    }, null, 2));
  } catch { /* a demo stub must never fail a request over its own cache */ }
}

function normaliseAddress(address) {
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`Invalid wallet address: ${address}`);
  }
  return address.toLowerCase();
}

const okResponse = (data) => ({ code: "0000", message: "ok", data });

/** Not reachable in local mode — present so the module surface matches. */
async function call() {
  throw new Error("cleanverse-local: no HTTP calls are made in DEMO_MODE=local");
}

/** Local mode does no AES; identity keeps the signature honest. */
function encrypt(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

// --------------------------------------------------------------- A-Pass

/**
 * Bind a wallet to a customerId.
 *
 * The real client retries with override:true when the API answers 1000
 * ("already exists"), so a rebind always ends up succeeding. We collapse that
 * round trip and just overwrite, which produces the same observable result.
 */
async function generateApass({ customerId, address, chain = CHAIN, expirationTime }) {
  const key = normaliseAddress(address);
  const cvRecordId = `LOCAL-${String(++recordSeq).padStart(4, "0")}`;
  bindings.set(key, {
    customerId: String(customerId),
    chain,
    status: 1,
    cvRecordId,
    expirationTime: expirationTime || 1900000000,
  });
  persist();
  return okResponse({ cvRecordId, customerId: String(customerId), walletAddress: key });
}

/** Freeze (2) or activate (1) a binding. */
async function updateStatus({ address, status }) {
  const key = normaliseAddress(address);
  const rec = bindings.get(key);
  if (!rec) return { code: "0002", message: "A-Pass not found", data: null };
  rec.status = Number(status);
  persist();
  return okResponse({ walletAddress: key, status: rec.status, txHash: null });
}

/** Single record by address. Mirrors the real endpoint: no customerId field. */
async function queryApass({ address, chain = CHAIN }) {
  const key = normaliseAddress(address);
  const rec = bindings.get(key);
  if (!rec) return { code: "0002", message: "A-Pass not found", data: null };
  return okResponse({
    walletAddress: key,
    chain: rec.chain || chain,
    status: rec.status,
    expirationTime: rec.expirationTime,
  });
}

/** The identity-equivalence source. Filtering by customerId lists every wallet. */
async function queryApassList(filter = {}) {
  const { customerId, address, page = 1, pageSize = 100 } = filter;
  let items = [...bindings.entries()].map(([walletAddress, rec]) => ({
    walletAddress,
    customerId: rec.customerId,
    chain: rec.chain,
    status: rec.status,
    expirationTime: rec.expirationTime,
  }));

  if (customerId) items = items.filter((i) => i.customerId === String(customerId));
  if (address) items = items.filter((i) => i.walletAddress === normaliseAddress(address));

  const start = (page - 1) * pageSize;
  return okResponse({ total: items.length, items: items.slice(start, start + pageSize) });
}

/** All wallets belonging to one person, lowercased. */
async function walletsForCustomer(customerId) {
  const res = await queryApassList({ customerId });
  return (res?.data?.items || []).map((r) => String(r.walletAddress).toLowerCase());
}

// ----------------------------------------------------------- compliance

const VERIFY_CODES = {
  1: "A-Token not found",
  2: "Wallet has no A-Pass",
  3: "A-Pass expired or frozen",
  4: "Verified — transfer allowed",
};

/** The pre-transaction gate, returning the same normalised verdict shape. */
async function verifyApass({ address, atoken }) {
  const key = normaliseAddress(address);
  const rec = bindings.get(key);

  let code;
  if (!atoken) code = 1;
  else if (!rec) code = 2;
  else if (rec.status !== 1 || rec.expirationTime * 1000 < Date.now()) code = 3;
  else code = 4;

  return {
    allowed: code === 4,
    code,
    reason: VERIFY_CODES[code],
    magickLink: undefined,
    raw: { code: "0000", message: "ok", data: { code } },
  };
}

// ---------------------------------------------------------------- misc

async function tokenList(chain = CHAIN) {
  return okResponse({ items: [], chain });
}

async function faucet({ symbol = "usdc", depositAddress, amount = "1", chain = CHAIN }) {
  return okResponse({ symbol, depositAddress, amount, chain, txHash: null });
}

/** Test/demo helper. Not part of the real client's surface. */
function _reset() {
  bindings.clear();
  recordSeq = 0;
}

module.exports = {
  call, encrypt, CHAIN, normaliseAddress,
  generateApass, updateStatus, queryApass, queryApassList, walletsForCustomer,
  verifyApass, tokenList, faucet,
  VERIFY_CODES,
  _reset,
};
