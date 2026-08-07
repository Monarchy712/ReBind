/**
 * Picks the Cleanverse implementation.
 *
 * Default is the real client, which throws on import unless CV_API_ID and
 * CV_API_KEY are set — that check is deliberate and must keep firing, so the
 * require stays lazy and we never load the real module in local mode.
 *
 * DEMO_MODE=local swaps in the in-memory stub so the demo runs offline.
 *
 * Re-exported BY REFERENCE, not spread. Callers and tests reach for the same
 * object — test/backend.test.js swaps out cv.walletsForCustomer to drive the
 * attestor — and copying the exports would silently break that link.
 */
const LOCAL = process.env.DEMO_MODE === "local";

// No extra properties are attached to the chosen module: it is a shared
// singleton, and tagging it would leak into everything else that requires it.
module.exports = LOCAL ? require("./cleanverse-local") : require("./cleanverse");
