/* =============================================================== format.js
   Pure formatters. No DOM, no React — the same functions the vanilla build
   used, so the numbers on screen render identically.
   ====================================================================== */

export const pad2 = (n) => String(n).padStart(2, "0");
export const short = (h, n = 10) => (h ? `${h.slice(0, n)}…${h.slice(-4)}` : "—");
export const shortTx = (h) => (h ? `${h.slice(0, 14)}…` : "");
export const num = (v) => Number(v || 0).toLocaleString();

/** /api/execute reports base units while /api/state is pre-formatted, so the
 *  trace used to end on "B: 250000000". Matches the token's 6 decimals. */
const NOTE_DECIMALS = 6;
export function units(v){
  const n = Number(v) / 10 ** NOTE_DECIMALS;
  return Number.isFinite(n) ? n.toLocaleString() : String(v);
}

export function clock(seconds){
  if (seconds === null || seconds === undefined) return "—";
  const s = Math.max(0, Math.floor(seconds));
  if (s >= 3600) return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}

export function humanWindow(s){
  if (s === null || s === undefined) return "the challenge window";
  if (s < 60) return `${s} seconds`;
  if (s < 3600){ const m = Math.round(s / 60); return `${m} minute${m === 1 ? "" : "s"}`; }
  return `${+(s / 3600).toFixed(1)} hours`;
}
