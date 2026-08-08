/* ============================================================ Console.jsx
   The issuer's side: every claim the queue has ever held, and the things an
   issuer can actually do — commit, approve, execute, or reject. All real
   calls against the deployed RecoveryQueue.
   ====================================================================== */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import { clock, humanWindow, num, short, shortTx } from "../lib/format.js";
import { countTo, once } from "../lib/motion.js";
import { ActionButton, OfflineBanner } from "../components/Bits.jsx";
import { Reveal } from "../components/Reveal.jsx";
import { useToast } from "../components/Toasts.jsx";
import { statusOf, useRebind } from "../store/RebindProvider.jsx";

function Stat({ label, value, count }){
  const ref = useRef(null);
  useEffect(() => {
    if (count && ref.current) countTo(ref, Number(value) || 0);
  }, [value, count]);
  return (
    <div className="stat">
      <div className="k lbl br">{label}</div>
      <div className="v" ref={ref}>{count ? undefined : value}</div>
    </div>
  );
}

export default function Console(){
  const S = useRebind();
  const toast = useToast();
  const [rows, setRows] = useState(null);          // null = still loading
  const [loadedAt, setLoadedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const st = await S.refreshState();
    const list = await S.refreshClaims(st?.claimCount);
    setRows(list);
    setLoadedAt(Date.now());
    return list;
  }, [S]);

  /* Load once when the app has booted.
     `load` is deliberately NOT a dependency. It closes over the whole store
     object, which is a new value on every provider render, so depending on its
     identity made this effect re-run on every render: load -> setState ->
     render -> load, a hot loop that fired ~5 requests a second. Each
     /api/state is a dozen RPC reads, so against a public testnet endpoint that
     is instant rate-limiting. A ref keeps the latest function without making
     it a trigger. */
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; });
  useEffect(() => { if (S.booted) loadRef.current(); }, [S.booted]);

  /* Countdowns tick locally between polls: re-reading the chain once a second
     per row would hammer the RPC for information we can infer. The offset is
     measured from when the rows were fetched, not from mount — otherwise a
     table loaded ten seconds in starts its clocks ten seconds short. */
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const sinceLoad = loadedAt ? Math.max(0, Math.floor((now - loadedAt) / 1000)) : 0;
  const claims = (rows || []).map((c) => ({
    ...c,
    timeRemaining: c.claim.executed || c.claim.cancelled
      ? c.timeRemaining
      : Math.max(0, c.timeRemaining - sinceLoad),
  }));

  const settled  = claims.filter((c) => c.claim.executed).length;
  const rejected = claims.filter((c) => c.claim.cancelled).length;

  const act = async (fn, label, id) => {
    try{
      const r = await fn();
      toast(`Claim #${id} ${label}${r?.txHash ? ` · ${shortTx(r.txHash)}` : ""}`, {
        title:label[0].toUpperCase() + label.slice(1), kind:"ok",
      });
      await load();
    }catch(e){
      toast(e.message, { title:"Action failed", kind:"err", ms:7000 });
    }
  };

  return (
    <div className="view page">
      <div className="wrap">
        <div className="spread wrapflex" style={{ marginBottom:26 }}>
          <div className="section-head" style={{ marginBottom:0 }}>
            <span className="kicker">02 · issuer console</span>
            <h2 className="display">
              the recovery queue. <span className="fade">approve, commit, or refuse.</span>
            </h2>
            <p className="section-sub">
              every claim the queue holds. approving is revocable until it is committed; rejecting
              restores the old wallet and moves nothing.
            </p>
          </div>
          <div className="row" style={{ gap:10 }}>
            {S.localMode ? (
              <ActionButton
                className="btn sm"
                onAction={async () => {
                  const r = await api.advanceTime(S.cureWindow ? S.cureWindow + 5 : 3600);
                  if (r.advanced) toast(`Chain time advanced by ${r.advanced}s.`, { title:"Fast-forwarded", kind:"ok" });
                  else toast(r.note || "This chain does not allow time travel.", { title:"Not available", kind:"warn" });
                  await load();
                }}
              >fast-forward window</ActionButton>
            ) : null}
            <ActionButton className="btn sm" onAction={load}>refresh</ActionButton>
          </div>
        </div>

        <OfflineBanner online={S.online} detail={S.connDetail} fallback="The console cannot read the queue." />

        <Reveal className="stats" style={{ marginBottom:18 }}>
          <Stat label="claims"    value={claims.length} count />
          <Stat label="in review" value={claims.length - settled - rejected} count />
          <Stat label="settled"   value={settled} count />
          <Stat label="rejected"  value={rejected} count />
          <Stat label="window"    value={humanWindow(S.cureWindow)} />
        </Reveal>

        <Reveal className="panel" delay={80}>
          <div className="panel-head">
            <span className="lbl br">recovery queue</span>
            <span className="chip info">
              {S.contracts ? `chain ${S.contracts.chainId}` : S.config ? `chain ${S.config.chainId}` : "—"}
            </span>
          </div>
          <div className="tablewrap">
            <table className="data">
              <thead>
                <tr>
                  <th>claim</th><th>from</th><th>to</th><th>status</th>
                  <th>window</th><th style={{ textAlign:"right" }}>actions</th>
                </tr>
              </thead>
              <tbody>
                {rows === null ? (
                  Array.from({ length:3 }).map((_, i) => (
                    <tr key={i}>{Array.from({ length:6 }).map((__, j) => (
                      <td key={j}><div className="skel" /></td>
                    ))}</tr>
                  ))
                ) : claims.length === 0 ? (
                  <tr><td colSpan={6}>
                    <div className="empty">
                      <h4>no claims yet</h4>
                      <p>The queue is empty. Open one from the recovery wizard, or run the scripted
                         demo to create a claim against Alice&apos;s wallets.</p>
                      <Link className="btn sm" to="/demo">run the demo</Link>
                    </div>
                  </td></tr>
                ) : claims.map((c) => {
                  const st = statusOf(c);
                  const done = c.claim.executed || c.claim.cancelled;
                  const elapsed = c.timeRemaining <= 0;
                  return (
                    <tr key={c.id}>
                      <td className="id">#{c.id}</td>
                      <td className="addr" title={c.claim.oldWallet}>{short(c.claim.oldWallet)}</td>
                      <td className="addr" title={c.claim.newWallet}>{short(c.claim.newWallet)}</td>
                      <td><span className={`chip ${st.kind}${st.key === "open" ? " live" : ""}`}>{st.label}</span></td>
                      <td className="mono tnum">{done ? "—" : elapsed ? "elapsed" : clock(c.timeRemaining)}</td>
                      <td>
                        <div className="rowacts">
                          {done ? <span className="chip">closed</span> : (
                            <>
                              {!c.claim.committed && S.advance.enabled ? (
                                <ActionButton className="btn sm"
                                  onAction={() => act(() => api.commit(c.id), "committed", c.id)}>commit</ActionButton>
                              ) : null}
                              {!c.claim.issuerApproved ? (
                                <ActionButton className="btn good sm"
                                  onAction={() => act(() => api.approve(c.id), "approved", c.id)}>approve</ActionButton>
                              ) : null}
                              <ActionButton
                                className="btn primary sm"
                                disabled={!(elapsed && c.claim.issuerApproved)}
                                onAction={(e, node) => { once(node, "unlocked", 900); return act(() => api.execute(c.id), "settled", c.id); }}
                              >execute</ActionButton>
                              {!c.claim.committed ? (
                                <ActionButton className="btn danger sm"
                                  onAction={() => act(() => api.cancel(c.id), "rejected", c.id)}>reject</ActionButton>
                              ) : null}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Reveal>
      </div>
    </div>
  );
}
