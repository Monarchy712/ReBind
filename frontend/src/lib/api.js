/* ================================================================== api.js
   The only module that talks to the backend. Everything else asks for data
   and gets either a value or a thrown Error with a message worth showing.

   The failure modes here are load-bearing: this page is routinely opened
   against a port with nothing on it, or against a plain static file server.
   Both used to surface as "Unexpected token '<'", which tells the user
   nothing about the actual problem.
   ====================================================================== */

const BASE = "";

/* ------------------------------------------------------------- demo session
   A BindingRegistry binding is permanent, so the demo's three wallets can only
   run the recovery story once. Resetting therefore does not undo anything: it
   moves to a new person on new addresses, which the backend derives from a
   session index this browser chooses.

   Holding the index here rather than on the server is what lets two people run
   the demo at the same time on one deployment without colliding — and it keeps
   the backend stateless, so a restart does not strand a session.

   Session 0 is the backend's configured wallets. We never ask for it: a fresh
   browser gets a fresh session, so the first visit is already clean. */
const SESSION_KEY = "rebind.session";

function newSessionId() {
  /* Hardened derivation paths cap at 2^31-1, and 0 means "configured". */
  const [n] = crypto.getRandomValues(new Uint32Array(1));
  return (n % 0x7ffffffe) + 1;
}

let session = (() => {
  try {
    const stored = Number(localStorage.getItem(SESSION_KEY));
    if (Number.isInteger(stored) && stored > 0) return stored;
  } catch { /* private mode */ }
  const fresh = newSessionId();
  try { localStorage.setItem(SESSION_KEY, String(fresh)); } catch { /* private mode */ }
  return fresh;
})();

export const currentSession = () => session;

/** Move to a brand-new session. The caller reloads config and state after. */
export function rotateSession() {
  session = newSessionId();
  try { localStorage.setItem(SESSION_KEY, String(session)); } catch { /* private mode */ }
  return session;
}

/* Connection state is global and observable — the nav pill and the offline
   banners all read from it rather than each running their own probe. */
const listeners = new Set();
export const conn = { online: true, detail: null };

export function onConnectionChange(fn){ listeners.add(fn); return () => listeners.delete(fn); }

function setConn(online, detail){
  if (conn.online === online && conn.detail === detail) return;
  conn.online = online;
  conn.detail = detail || null;
  document.body.classList.toggle("offline", !online);
  listeners.forEach(fn => fn(conn));
}

async function request(path, opts){
  let r;
  try{
    /* Every call carries the session, so nothing downstream has to remember to
       thread it through. The backend reads it off the header and derives that
       session's wallets and keys. */
    r = await fetch(BASE + path, {
      ...opts,
      headers: { ...(opts?.headers || {}), "X-Rebind-Session": String(session) },
    });
  }catch{
    setConn(false, "Nothing is listening on this port. Start the backend with `npm run server:local` for the offline demo, or `npm run server` against a testnet.");
    throw new Error("Backend unreachable — is the server running?");
  }

  const text = await r.text();
  let j;
  try{
    j = JSON.parse(text);
  }catch{
    setConn(false, `Got a reply on this port, but not JSON (HTTP ${r.status}). This is probably a plain file server, not the Rebind backend.`);
    throw new Error(`Backend returned non-JSON (HTTP ${r.status})`);
  }

  setConn(true);
  if (!j.ok) throw new Error(j.error || `Request failed (HTTP ${r.status})`);
  return j;
}

const post = (path, body) => request(path, {
  method:"POST",
  headers:{ "Content-Type":"application/json" },
  body:JSON.stringify(body || {}),
});

/** Reads that drive polling: a failure updates connection state, not the UI. */
export async function tryGet(path){
  try{ return await request(path); }catch{ return null; }
}

export const api = {
  config:        ()                 => request("/api/config"),
  /* Rotate first, so the reset call itself is made as the NEW session — that
     is what the backend validates and tops the vault up for. */
  reset:         ()                 => { rotateSession(); return post("/api/reset"); },
  state:         (wallets)          => request(`/api/state?wallets=${wallets.filter(Boolean).join(",")}`),
  claim:         (id)               => request(`/api/claim/${id}`),

  register:      (body)             => post("/api/register", body),
  mint:          (to, amount)       => post("/api/mint", { to, amount }),
  check:         (from, to)         => post("/api/check", { from, to }),
  openClaim:     (body)             => post("/api/claim", body),
  approve:       (claimId)          => post("/api/approve", { claimId }),
  cancel:        (claimId)          => post("/api/cancel", { claimId }),
  commit:        (claimId)          => post("/api/commit", { claimId }),
  execute:       (claimId)          => post("/api/execute", { claimId }),

  advanceQuote:  (id)               => request(`/api/advance/${id}`),
  drawAdvance:   (claimId)          => post("/api/advance/draw", { claimId }),

  /* Local dev node only. Against a real chain the backend reports advanced:0
     with a note, so callers must treat success as "maybe". */
  advanceTime:   (seconds)          => post("/api/advance-time", { seconds }),
  vault: {
    getFallbackReceiver: () => request("/api/vault/fallback-receiver"),
    setFallbackReceiver: (address) => post("/api/vault/fallback-receiver", { address }),
    getRepaymentFailures: () => request("/api/vault/repayment-failures"),
  },
  guardian: {
    getRequests: () => request("/api/guardian-replace/requests"),
    openRequest: (body) => post("/api/guardian-replace/open", body),
    cancelRequest: (requestId) => post("/api/guardian-replace/cancel", { requestId }),
    finalizeRequest: (requestId) => post("/api/guardian-replace/finalize", { requestId }),
  },
};

/* Soft variants for polling paths, where a blip must not throw into a view. */
export const safe = {
  state:  (wallets, customerId) => tryGet(`/api/state?wallets=${wallets.filter(Boolean).join(",")}${customerId ? `&customerId=${customerId}` : ""}`),
  claim:  (id)      => tryGet(`/api/claim/${id}`),
  advance:(id)      => tryGet(`/api/advance/${id}`),
};
