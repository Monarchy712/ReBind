/* ====================================================== RebindProvider.jsx
   One shared source of truth for config, wallet state, claims, and where the
   scripted demo has got to — the React replacement for the vanilla store.

   Two things are deliberate:

   • One poll loop for the whole app, held here rather than in each route, so
     switching routes cannot multiply the polling against the RPC.
   • The demo's beat lives here, not in the Demo route, so navigating to the
     console and back does not restart Alice's story.
   ====================================================================== */

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, safe, conn, onConnectionChange } from "../lib/api.js";

const Ctx = createContext(null);
export const useRebind = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useRebind must be used inside <RebindProvider>");
  return v;
};

/* ------------------------------------------------------------------ beats */
export const BEAT_TITLES = {
  register: "Register & issue",
  steal: "Theft blocked",
  compromise: "Key compromised",
  claim: "Recovery claim",
  review: "Issuer review",
  advance: "Bridge advance",
  done: "Resolved",
};

/* Beats are named, never positional. The bridge advance only exists when a
   vault is deployed, and index arithmetic against a variable-length flow is
   how off-by-one bugs get written. */
export const buildBeats = (advanceEnabled) =>
  advanceEnabled
    ? ["register", "steal", "compromise", "claim", "review", "advance", "done"]
    : ["register", "steal", "compromise", "claim", "review", "done"];

/* ----------------------------------------------------------- customer id */
/* The customerId must survive a reload: a resumed session opens its claim
   against the identity A and B were registered under, and a fresh id would
   make the attestor correctly refuse to attest. Keyed by token address so a
   redeploy starts a clean session. */
function sessionCustomerId(token) {
  const key = "rebind.cid." + token;
  let v = null;
  try {
    v = localStorage.getItem(key);
  } catch {
    /* private mode */
  }
  if (!v) {
    v = "ALICEDEMO" + Date.now().toString().slice(-6);
    try {
      localStorage.setItem(key, v);
    } catch {
      /* private mode */
    }
  }
  return v;
}

export function statusOf(c) {
  if (c.claim.executed) return { key: "settled", label: "settled", kind: "ok" };
  if (c.claim.cancelled)
    return { key: "rejected", label: "rejected", kind: "bad" };
  if (c.claim.committed)
    return { key: "committed", label: "committed", kind: "info" };
  if (c.claim.issuerApproved)
    return { key: "approved", label: "approved", kind: "info" };
  if (c.executable) return { key: "ready", label: "executable", kind: "warn" };
  return { key: "open", label: "in window", kind: "warn" };
}

export function RebindProvider({ children }) {
  const [config, setConfig] = useState(null);
  const [balances, setBalances] = useState({});
  const [contracts, setContracts] = useState(null);
  const [claimCount, setClaimCount] = useState(0);
  const [claims, setClaims] = useState([]);
  const [online, setOnline] = useState(conn.online);
  const [connDetail, setConnDetail] = useState(conn.detail);
  const [booted, setBooted] = useState(false);

  const [liveGuardian, setLiveGuardian] = useState(null);
  const [activeGuardianRequest, setActiveGuardianRequest] = useState(null);
  const [recoverSubMode, setRecoverSubMode] = useState("claim");

  /* Demo flow */
  const [beat, setBeat] = useState(0);
  const [claimId, setClaimId] = useState(null);
  const [rejected, setRejected] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const [lastSplit, setLastSplit] = useState(null);
  const [adv, setAdv] = useState(null);

  const customerId = useMemo(
    () => (config?.token ? sessionCustomerId(config.token) : null),
    [config?.token],
  );
  const wallets = config?.wallets || {};
  const guardian = config?.guardian || { address: null, canCoSign: false };
  const advance = config?.advance || { enabled: false };
  const beats = useMemo(() => buildBeats(advance.enabled), [advance.enabled]);

  const beatId = beats[beat];

  /* goTo reads the beat list through a ref so its identity stays stable: as a
     dependency of the demo's effects, a goTo that changed on every config
     update would tear those effects down and restart their timers. */
  const beatsRef = useRef(beats);
  useEffect(() => {
    beatsRef.current = beats;
  }, [beats]);

  const goTo = useCallback(
    (id) =>
      setBeat((b) => {
        const i = beatsRef.current.indexOf(id);
        return i >= 0 ? i : b;
      }),
    [],
  );

  const atOrPast = useCallback(
    (id) => beat >= beats.indexOf(id),
    [beat, beats],
  );

  const walletList = useCallback(
    () => [wallets.A, wallets.B, wallets.X, wallets.G2].filter(Boolean),
    [wallets.A, wallets.B, wallets.X, wallets.G2],
  );

  /* ------------------------------------------------------------- reads */
  const refreshState = useCallback(async () => {
    const list = walletList();
    if (!list.length) return null;
    const r = await safe.state(list, customerId);
    if (!r) return null;
    setBalances(r.wallets || {});
    setContracts(r.contracts || null);
    setClaimCount(r.claimCount || 0);
    setLiveGuardian(r.liveGuardian || null);
    setActiveGuardianRequest(r.activeGuardianRequest || null);
    return r;
  }, [walletList, customerId]);

  /** Full claim list for the console. Sequential on purpose: these hit a chain
   *  through one provider, and firing N parallel reads at a public RPC is how
   *  you get rate-limited mid-demo. */
  const refreshClaims = useCallback(
    async (count) => {
      const n = count ?? claimCount;
      const out = [];
      for (let id = n - 1; id >= 0; id--) {
        const c = await safe.claim(id);
        if (c) out.push({ id, ...c });
      }
      setClaims(out);
      return out;
    },
    [claimCount],
  );

  const refreshAdvance = useCallback(
    async (id = claimId) => {
      if (!advance.enabled || id === null || id === undefined) {
        setAdv(null);
        return null;
      }
      const a = await safe.advance(id);
      if (a && wallets.A) {
        const st = await safe.state([wallets.A]);
        a.claimNote = st?.wallets?.[wallets.A]?.balance ?? null;
      }
      setAdv(a);
      return a;
    },
    [advance.enabled, claimId, wallets.A],
  );

  /* ------------------------------------------------------------ resume */
  /**
   * Rebuild the demo position from chain state.
   *
   * Progress used to live only in page memory, so a reload dropped you at
   * "Register & mint" while the chain still held 250 NOTE, an active binding
   * and possibly an open claim — and clicking through again minted a second 250.
   *
   * Beats 2 and 3 leave no trace to read back: the blocked transfer is a
   * read-only preflight and "key compromised" is pure narration. A resumed
   * session therefore lands on the last beat the chain can actually prove.
   */
  const resume = useCallback(
    async (cfg) => {
      const c = cfg || config;
      if (!c) return false;
      const w = c.wallets || {};
      const list = Object.values(w).filter(Boolean);
      const st = await safe.state(list);
      if (!st) return false;

      setBalances(st.wallets || {});
      setContracts(st.contracts || null);
      setClaimCount(st.claimCount || 0);

      const seq = buildBeats(c.advance?.enabled);
      const jump = (id) => setBeat(Math.max(0, seq.indexOf(id)));

      if (st.claimCount > 0) {
        const id = st.claimCount - 1;
        const cl = await safe.claim(id);
        if (cl) {
          setClaimId(id);

          if (cl.claim.executed) {
            setRecovered(true);
            /* Rebuild the settlement split so a reload still shows how the
             recovery divided. previewSplit reports nothing once the advance
             is settled, so it comes from the advance record instead. */
            if (c.advance?.enabled) {
              const a = await safe.advance(id);
              setAdv(a);
              if (a?.advance?.drawn) {
                const kept = parseFloat(st.wallets?.[w.B]?.balance || 0);
                const toVault = parseFloat(a.advance.dueNote || 0);
                setLastSplit({
                  total: (kept + toVault).toLocaleString(),
                  toVault: a.advance.dueNote,
                  toWallet: String(kept),
                });
              }
            }
            jump("done");
            return true;
          }

          if (cl.claim.cancelled) {
            setRejected(true);
            jump("review");
            return true;
          }

          /* A committed claim has passed review and is what the vault lends
           against, so a resumed session belongs on the advance beat. */
          if (c.advance?.enabled && cl.claim.committed) {
            const a = await safe.advance(id);
            setAdv(a);
            jump("advance");
            return true;
          }
          jump("review");
          return true;
        }
      }

      const balA = parseFloat(st.wallets?.[w.A]?.balance || 0);
      jump(balA > 0 ? "steal" : "register");
      return balA > 0;
    },
    [config],
  );

  /* -------------------------------------------------------------- boot */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await api.config();
        if (cancelled) return;
        setConfig(cfg);
        await resume(cfg);
      } catch {
        // The connection listener below surfaces this; the UI still renders.
      } finally {
        if (!cancelled) setBooted(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Deliberately once: re-running would restart Alice's story.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Connection state lives in its own listener set inside api.js, so it needs
     its own subscription — a state subscription alone never fires when the
     backend goes away. */
  useEffect(
    () =>
      onConnectionChange((c) => {
        setOnline(c.online);
        setConnDetail(c.detail);
      }),
    [],
  );

  /* One poll loop for the whole app. A hidden tab does not need the chain. */
  useEffect(() => {
    if (!config) return undefined;
    const t = setInterval(() => {
      if (!document.hidden) refreshState();
    }, 4000);
    return () => clearInterval(t);
  }, [config, refreshState]);

  /* Memoised so consumers are not handed a new object on every render. An
     unmemoised context value re-renders every subscriber whenever anything
     here changes, and any consumer effect that depends on a callback from it
     re-runs on every render — which is exactly how the console ended up
     re-fetching in a loop. */
  const value = useMemo(
    () => ({
      // config
      config,
      booted,
      wallets,
      guardian,
      advance,
      customerId,
      cureWindow: config?.cureWindow ?? null,
      localMode: !!config?.localMode,
      // chain
      balances,
      contracts,
      claimCount,
      claims,
      liveGuardian,
      activeGuardianRequest,
      recoverSubMode,
      setRecoverSubMode,
      refreshState,
      refreshClaims,
      refreshAdvance,
      // connection
      online,
      connDetail,
      // demo flow
      beats,
      beat,
      beatId,
      setBeat,
      goTo,
      atOrPast,
      claimId,
      setClaimId,
      rejected,
      setRejected,
      recovered,
      setRecovered,
      lastSplit,
      setLastSplit,
      adv,
      setAdv,
      resume,
    }),
    [
      config,
      booted,
      wallets,
      guardian,
      advance,
      customerId,
      balances,
      contracts,
      claimCount,
      claims,
      liveGuardian,
      activeGuardianRequest,
      recoverSubMode,
      setRecoverSubMode,
      refreshState,
      refreshClaims,
      refreshAdvance,
      online,
      connDetail,
      beats,
      beat,
      beatId,
      goTo,
      atOrPast,
      claimId,
      rejected,
      recovered,
      lastSplit,
      adv,
      resume,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
