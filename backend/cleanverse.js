/**
 * Cleanverse API v5.6 client.
 *
 * TWO THINGS THAT WILL BITE YOU IF YOU FORGET THEM
 * ------------------------------------------------
 * 1. Every response is HTTP 200. Never branch on `response.ok`. Check `code`.
 *    A 403 almost always means your AES encryption is wrong, not that auth failed.
 *
 * 2. A frozen A-Pass does NOT return data.code === 3 as documented. It returns
 *    outer code "0002" with the on-chain revert text "APassNotActive" and no
 *    data.code field at all. Verified against the live sandbox. Handle both.
 */
const crypto = require("crypto");

const BASE_URL = process.env.CV_BASE_URL || "https://uatapi.cleanverse.com/api/cooperate";
const API_ID = process.env.CV_API_ID;
const API_KEY = process.env.CV_API_KEY;
const CHAIN = process.env.CV_CHAIN || "base";

if (!API_ID || !API_KEY) {
  throw new Error("Set CV_API_ID and CV_API_KEY in .env");
}

// Fixed IV of 16 zero bytes. NOT random. This is what the docs specify.
const IV = Buffer.alloc(16, 0);

// The Cleanverse sandbox accepted the lowercase addresses used by the scope
// probe but can return CV_500 for checksum-cased input. Normalise every wallet
// at the API boundary; Ethereum addresses are case-insensitive on-chain.
function normaliseAddress(address) {
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`Invalid wallet address: ${address}`);
  }
  return address.toLowerCase();
}

function encrypt(obj) {
  const key = Buffer.from(API_KEY, "base64"); // decode FIRST, then use raw bytes
  const cipher = crypto.createCipheriv("aes-256-cbc", key, IV);
  return Buffer.concat([
    cipher.update(JSON.stringify(obj), "utf8"),
    cipher.final(),
  ]).toString("base64");
}

async function call(path, body, { encrypted = false, method = "POST" } = {}) {
  const headers = {
    "api-id": API_ID,
    "Content-Type": "application/json",
    "X-Request-ID": crypto.randomUUID(),
  };
  const opts = { method, headers };
  if (method !== "GET") {
    opts.body = JSON.stringify(encrypted ? { data: encrypt(body) } : body);
  }

  const res = await fetch(BASE_URL + path, opts);
  const json = await res.json().catch(() => ({ code: "-1", message: "unparseable response" }));

  if (res.status === 403) {
    throw new Error(
      `403 from ${path}. Usually AES encryption, not auth. ` +
      `Check: Base64-decode the api-key first, IV is 16 zero bytes, PKCS padding.`
    );
  }
  return json;
}

// --------------------------------------------------------------- A-Pass

/** Create an A-Pass, or bind an ADDITIONAL wallet to an existing customerId. */
async function generateApass({ customerId, address, chain = CHAIN, override = false, expirationTime }) {
  const body = {
    customerId,
    expirationTime: expirationTime || 1900000000,
    wallet: { address: normaliseAddress(address), chain },
    ...(override ? { override: true } : {}),
  };
  let res = await call("/generate_apass", body, { encrypted: true });

  // Documented special case: 1000 means "already exists, retry with override".
  if (String(res.code) === "1000") {
    res = await call("/generate_apass", { ...body, override: true }, { encrypted: true });
  }
  return res;
}

/** Freeze (2) or activate (1) a binding. */
async function updateStatus({ customerId, address, chain = CHAIN, status, reason }) {
  return call("/update_status", {
    customerId,
    status: String(status),
    ...(reason ? { blacklistReason: reason } : {}),
    wallet: { chain, address: normaliseAddress(address) },
  }, { encrypted: true });
}

/** Single record by address. NOTE: does NOT return customerId. */
async function queryApass({ address, chain = CHAIN }) {
  return call("/query_apass", { chain, address: normaliseAddress(address) });
}

/**
 * THE IDENTITY-EQUIVALENCE SOURCE.
 * Filtering by customerId returns EVERY wallet bound to that person.
 * This is the only endpoint that exposes the link, which is why the
 * attestation has to be signed off-chain.
 */
async function queryApassList(filter = {}) {
  return call("/query_apass_list", { page: 1, pageSize: 100, ...filter });
}

/** All wallets belonging to one person, lowercased. */
async function walletsForCustomer(customerId) {
  const res = await queryApassList({ customerId });
  const items = res?.data?.items || [];
  return items.map((r) => String(r.walletAddress).toLowerCase());
}

// ----------------------------------------------------------- compliance

const VERIFY_CODES = {
  1: "A-Token not found",
  2: "Wallet has no A-Pass",
  3: "A-Pass expired or frozen",
  4: "Verified — transfer allowed",
};

/** The pre-transaction gate. Returns a normalised, UI-friendly verdict. */
async function verifyApass({ address, atoken, chain = CHAIN }) {
  const res = await call("/verify_apass", { chain, atoken, address: normaliseAddress(address) });

  // Normal documented path
  if (String(res.code) === "0000" && res.data && typeof res.data.code === "number") {
    const c = res.data.code;
    return {
      allowed: c === 4,
      code: c,
      reason: VERIFY_CODES[c] || res.data.message || "Unknown",
      magickLink: res.data.magickLink,
      raw: res,
    };
  }

  // UNDOCUMENTED: frozen passes surface the on-chain revert here instead.
  if (String(res.code) === "0002" && /APassNotActive/i.test(res.message || "")) {
    return {
      allowed: false,
      code: 3,
      reason: "A-Pass is frozen (on-chain: APassNotActive)",
      magickLink: res.data?.magickLink,
      raw: res,
    };
  }

  return { allowed: false, code: null, reason: res.message || "Unknown", raw: res };
}

// ---------------------------------------------------------------- misc

async function tokenList(chain = CHAIN) {
  return call("/query_deposit_atoken_list", { chain });
}

/** txHash -> a real downloadable PDF. This is your audit pack. */
async function travelRuleReport({ txHash, address, chain = CHAIN, customerId }) {
  return call("/download_travel_rule", {
    ...(customerId ? { customerId } : {}),
    txHash,
    wallet: { chain, address },
  });
}

async function faucet({ symbol = "usdc", depositAddress, amount = "1", chain = CHAIN }) {
  return call("/faucet", { chain, symbol, depositAddress, amount });
}

module.exports = {
  call, encrypt, CHAIN, normaliseAddress,
  generateApass, updateStatus, queryApass, queryApassList, walletsForCustomer,
  verifyApass, tokenList, travelRuleReport, faucet,
  VERIFY_CODES,
};
