/* ================================================================== api.js
   The only module that talks to the backend. Everything else asks for data
   and gets either a value or a thrown Error with a message worth showing.

   The failure modes here are load-bearing: this page is routinely opened
   against a port with nothing on it, or against a plain static file server.
   Both used to surface as "Unexpected token '<'", which tells the user
   nothing about the actual problem.
   ====================================================================== */

const BASE = "";

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
    r = await fetch(BASE + path, opts);
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
};

/* Soft variants for polling paths, where a blip must not throw into a view. */
export const safe = {
  state:  (wallets) => tryGet(`/api/state?wallets=${wallets.filter(Boolean).join(",")}`),
  claim:  (id)      => tryGet(`/api/claim/${id}`),
  advance:(id)      => tryGet(`/api/advance/${id}`),
};
