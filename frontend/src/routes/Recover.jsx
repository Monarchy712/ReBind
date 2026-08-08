/* ============================================================ Recover.jsx
   The owner's side: a four-step wizard that opens a real claim and then
   tracks it. Every step says what it will do to the chain before it does it.
   ====================================================================== */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, safe } from "../lib/api.js";
import { humanWindow, short, shortTx } from "../lib/format.js";
import { ActionButton, OfflineBanner, Ring } from "../components/Bits.jsx";
import { Reveal } from "../components/Reveal.jsx";
import { useToast } from "../components/Toasts.jsx";
import { useRebind } from "../store/RebindProvider.jsx";

const STEPS = [
  { key:"identity",    label:"confirm identity",   sub:"who you are at the issuer" },
  { key:"destination", label:"choose destination", sub:"where the asset goes" },
  { key:"guardian",    label:"guardian co-sign",   sub:"the second signature" },
  { key:"track",       label:"track the claim",    sub:"freeze, review, settle" },
];

export default function Recover(){
  const S = useRebind();
  const toast = useToast();

  const [step, setStep] = useState(0);
  const [form, setForm] = useState({ customerId:"", oldWallet:"", newWallet:"" });
  const [claimId, setClaimId] = useState(null);
  const [tracked, setTracked] = useState(null);
  const [total, setTotal] = useState(null);

  /* Prefill from the configured demo wallets: this backend controls them, so
     they are the only wallets this UI can actually sign for. */
  useEffect(() => {
    setForm({
      customerId:S.customerId || "",
      oldWallet:S.wallets.A || "",
      newWallet:S.wallets.B || "",
    });
  }, [S.customerId, S.wallets.A, S.wallets.B]);

  /* Track the opened claim. */
  useEffect(() => {
    if (claimId === null) return undefined;
    let alive = true;
    const tick = async () => {
      const r = await safe.claim(claimId);
      if (!alive || !r) return;
      setTracked(r);
      setTotal((t) => t ?? (S.cureWindow || Math.max(r.timeRemaining, 1)));
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(t); };
  }, [claimId, S.cureWindow]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]:e.target.value }));

  const next = useCallback(() => {
    const key = STEPS[step].key;
    if (key === "identity"){
      if (!form.customerId.trim() || !form.oldWallet.trim()){
        toast("Both fields are required to prove the identity link.", { title:"Missing details", kind:"warn" });
        return;
      }
    }
    if (key === "destination"){
      if (!form.newWallet.trim()){
        toast("A destination wallet is required.", { title:"Missing details", kind:"warn" });
        return;
      }
      if (form.newWallet.trim().toLowerCase() === form.oldWallet.trim().toLowerCase()){
        toast("The destination must be a different wallet from the one you lost.", { title:"Same wallet", kind:"warn" });
        return;
      }
    }
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  }, [step, form, toast]);

  const open = async () => {
    try{
      const r = await api.openClaim({
        customerId:form.customerId.trim(),
        oldWallet:form.oldWallet.trim(),
        newWallet:form.newWallet.trim(),
      });
      setClaimId(r.claimId);
      S.setClaimId(r.claimId);
      toast(`Claim #${r.claimId} opened · ${shortTx(r.txHash)}`, { title:"Wallet frozen", kind:"ok", ms:6000 });
      setStep(3);
      await S.refreshState();
    }catch(e){
      toast(e.message, { title:"Could not open the claim", kind:"err", ms:8000 });
    }
  };

  const destState = S.balances[form.newWallet];
  const destVerified = destState?.active && !destState?.revoked;

  const body = (() => {
    const key = STEPS[step].key;

    if (key === "identity") return (
      <>
        <h2 className="display" style={{ fontSize:"var(--step-3)", marginBottom:14 }}>Confirm your identity</h2>
        <p style={{ color:"var(--muted)", maxWidth:"60ch", lineHeight:1.6, marginBottom:24 }}>
          Recovery works because the issuer&apos;s KYC provider already knows that two wallets belong
          to one person. That link is what gets proven — not possession of a key.
        </p>
        <div className="field">
          <label htmlFor="cid">Customer ID</label>
          <input id="cid" value={form.customerId} onChange={set("customerId")} spellCheck="false" autoComplete="off" />
          <div className="help">Your identifier at Cleanverse. Both wallets must be registered under it.</div>
        </div>
        <div className="field">
          <label htmlFor="old">Wallet you lost access to</label>
          <input id="old" value={form.oldWallet} onChange={set("oldWallet")} spellCheck="false" autoComplete="off" />
          <div className="help">This wallet freezes the moment the claim opens, so a stolen key cannot race your recovery.</div>
        </div>
        <button className="btn primary" onClick={next}>Continue</button>
      </>
    );

    if (key === "destination") return (
      <>
        <h2 className="display" style={{ fontSize:"var(--step-3)", marginBottom:14 }}>Where should it go?</h2>
        <p style={{ color:"var(--muted)", maxWidth:"60ch", lineHeight:1.6, marginBottom:24 }}>
          The destination has to already hold an A-Pass under the same customer ID. The token
          enforces this itself — an unverified destination is refused on-chain, whatever the issuer
          wants.
        </p>
        <div className="field">
          <label htmlFor="dest">Destination wallet</label>
          <input id="dest" value={form.newWallet} onChange={set("newWallet")} spellCheck="false" autoComplete="off" />
          <div className="help">
            {destVerified
              ? <span style={{ color:"var(--good)" }}>✓ This wallet is verified and can receive the asset.</span>
              : "Status unknown until the attestor checks. If it has no A-Pass, the claim will be refused."}
          </div>
        </div>
        <div className="row" style={{ gap:10 }}>
          <button className="btn" onClick={() => setStep((s) => s - 1)}>Back</button>
          <button className="btn primary" onClick={next}>Continue</button>
        </div>
      </>
    );

    if (key === "guardian") return (
      <>
        <h2 className="display" style={{ fontSize:"var(--step-3)", marginBottom:14 }}>The guardian must co-sign</h2>
        <p style={{ color:"var(--muted)", maxWidth:"60ch", lineHeight:1.6, marginBottom:22 }}>
          One signature is not enough. The attestor proves the two wallets share an identity, and a
          guardian nominated when you registered signs the same claim under a separate EIP-712 type.
          A stolen attestor key cannot produce both halves.
        </p>
        <div className="guardian" style={{ margin:"0 0 22px" }}>
          <span className="lbl br">guardian</span>
          <span className="val">{S.guardian.address || "not configured"}</span>
          <span className={`chip ${S.guardian.canCoSign ? "ok" : "warn"}`}>
            {S.guardian.canCoSign ? "can co-sign" : "signature required"}
          </span>
        </div>
        <div className={`banner ${S.guardian.canCoSign ? "info" : "warn"}`} style={{ marginBottom:22 }}>
          <span className="ico">{S.guardian.canCoSign ? "note" : "warn"}</span>
          <div>
            <b>{S.guardian.canCoSign ? "This backend holds the guardian key" : "No guardian key on this backend"}</b>
            <p>{S.guardian.canCoSign
              ? "It will co-sign the claim automatically. In production the guardian is a separate party who reviews and signs on their own device."
              : "Opening the claim will revert unless a guardian signature is supplied."}</p>
          </div>
        </div>
        <div className="row" style={{ gap:10 }}>
          <button className="btn" onClick={() => setStep((s) => s - 1)}>Back</button>
          <ActionButton className="btn primary" onAction={open}>Open the recovery claim</ActionButton>
        </div>
        <div className="hint">
          This writes to the chain: it opens the claim and freezes {short(form.oldWallet)} in the
          same transaction.
        </div>
      </>
    );

    // track
    const c = tracked?.claim;
    const settled = c?.executed, rejected = c?.cancelled;
    return (
      <>
        <div className="spread wrapflex" style={{ marginBottom:18 }}>
          <h2 className="display" style={{ fontSize:"var(--step-3)" }}>
            {settled ? "Recovered" : rejected ? "Claim rejected" : "Claim is open"}
          </h2>
          <span className={`chip ${settled ? "ok" : rejected ? "bad" : "info live"}`}>claim #{claimId}</span>
        </div>
        <p style={{ color:"var(--muted)", maxWidth:"62ch", lineHeight:1.6, marginBottom:24 }}>
          {settled
            ? "The asset has moved to your destination wallet. The old wallet stays frozen and empty."
            : rejected
              ? "The issuer rejected this claim as an impersonation attempt. Your old wallet has been unfrozen and nothing moved."
              : `Your old wallet is frozen. The issuer now has ${humanWindow(S.cureWindow)} to reject the claim if it looks fraudulent. If nobody objects, the recovery becomes executable.`}
        </p>

        {settled || rejected ? null : (
          <Ring remaining={tracked ? tracked.timeRemaining : null} total={total} />
        )}

        <div className="stats" style={{ marginBottom:22 }}>
          <div className="stat"><div className="k">From</div>
            <div className="v" style={{ fontSize:14, fontFamily:"var(--mono)" }}>{short(c?.oldWallet || form.oldWallet)}</div></div>
          <div className="stat"><div className="k">To</div>
            <div className="v" style={{ fontSize:14, fontFamily:"var(--mono)" }}>{short(c?.newWallet || form.newWallet)}</div></div>
          <div className="stat"><div className="k">Status</div>
            <div className="v" style={{ fontSize:16 }}>
              {settled ? "settled" : rejected ? "rejected" : c?.issuerApproved ? "approved" : "in review"}
            </div></div>
        </div>

        <div className="row" style={{ gap:10, flexWrap:"wrap" }}>
          <Link className="btn" to="/console">Open the issuer console</Link>
          {settled || rejected ? (
            <button className="btn" onClick={() => { setClaimId(null); setTracked(null); setTotal(null); setStep(0); }}>
              Start another recovery
            </button>
          ) : null}
        </div>
        <div className="hint">
          The issuer approves and settles from the console — a recovery is never something the
          claimant can push through alone.
        </div>
      </>
    );
  })();

  return (
    <div className="view page">
      <div className="wrap">
        <Reveal className="section-head">
          <span className="kicker">03 · recovery</span>
          <h2 className="display">
            you lost the key. <span className="fade">you did not lose who you are.</span>
          </h2>
        </Reveal>
        <Reveal as="p" className="section-sub" delay={60}>
          You lost access to a wallet holding a permissioned asset. If another wallet of yours
          passed the same KYC check, the asset can be moved there — without the issuer being able
          to invent the claim.
        </Reveal>

        <OfflineBanner online={S.online} detail={S.connDetail} fallback="No claim can be opened right now." />

        <div className="wizard">
          <Reveal className="wsteps">
            {STEPS.map((s, i) => (
              <div key={s.key} className={`wstep ${i === step ? "on" : i < step ? "done" : ""}`}>
                <span className="dot">{i < step ? "✓" : String(i + 1).padStart(2, "0")}</span>
                <span className="lbl2">{s.label}<span className="sub">{s.sub}</span></span>
              </div>
            ))}
          </Reveal>
          <Reveal className="panel pad" delay={80}>{body}</Reveal>
        </div>
      </div>
    </div>
  );
}
