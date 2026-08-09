/* =============================================================== Bits.jsx
   The small shared pieces: offline banner, status chip, countdown ring,
   the beat rail, and the busy-button wrapper. All render exactly the class
   names app.css already defines.
   ====================================================================== */

import { useEffect, useRef, useState } from "react";
import { clock } from "../lib/format.js";

export const CIRC = 2 * Math.PI * 36;   // r=36 on the ring

export function OfflineBanner({ online, detail, fallback }){
  if (online) return null;
  return (
    <div className="banner">
      <span className="ico">err</span>
      <div>
        <b>backend unreachable</b>
        <p>{detail || fallback}</p>
      </div>
    </div>
  );
}

export function Chip({ kind, live, children, ...rest }){
  return (
    <span className={`chip${kind ? ` ${kind}` : ""}${live ? " live" : ""}`} {...rest}>
      {children}
    </span>
  );
}

export function Label({ bracket = true, className = "", children }){
  return <span className={`lbl${bracket ? " br" : ""}${className ? ` ${className}` : ""}`}>{children}</span>;
}

/** Countdown ring. `total` seeds the arc from the deployed window rather than
 *  the first reading, so a resumed session mid-window does not draw from empty. */
export function Ring({ remaining, total, label }){
  const done = remaining !== null && remaining <= 0;
  const frac = total ? Math.min(1, Math.max(0, 1 - (remaining ?? total) / total)) : 0;
  return (
    <div className={`ring${done ? " done" : ""}`}>
      <svg width="84" height="84" viewBox="0 0 76 76" aria-hidden="true">
        <circle className="track" cx="38" cy="38" r="36" />
        <circle
          className="prog"
          cx="38" cy="38" r="36"
          strokeDasharray={CIRC.toFixed(1)}
          strokeDashoffset={(CIRC * frac).toFixed(1)}
        />
      </svg>
      <div>
        <div className="t">{remaining === null ? "—" : clock(remaining)}</div>
        <div className="s">{label ?? (done ? "window elapsed" : "challenge window")}</div>
      </div>
    </div>
  );
}

export function Rail({ beats, beat, titles }){
  return (
    <div className="rail" style={{ gridTemplateColumns:`repeat(${beats.length},1fr)` }}>
      {beats.map((id, i) => (
        <div key={id} className={`rstep ${i < beat ? "done" : i === beat ? "on" : ""}`}>
          <span className="n">{String(i + 1).padStart(2, "0")}</span>
          <div className="t">{titles[id]}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * A button that owns every reason it might not be pressable, and draws them
 * all the same way: a bar across the control itself.
 *
 * Two reasons exist, and they are deliberately not distinguished visually,
 * because from the reader's side they are one thing — "not yet".
 *
 *   in flight   its own async handler is running. Every one of these sends a
 *               transaction, so it also cannot be double-fired. Sweeps, since
 *               a transaction has no predictable length.
 *   gated       something else has to happen first. Pass `progress` as a
 *               number 0..1 to fill left-to-right and unlock at 1 — a wait of
 *               known length, a challenge window mostly — or as "pending" to
 *               sweep, for a wait whose end we cannot predict, like polling
 *               until a vault quote is readable.
 *
 * A gated button is disabled and shows `waitLabel` instead of its children, so
 * the countdown lives in the control rather than only in a hint underneath it.
 * Reaching 1 fires the unlock pulse, which is the moment worth noticing. An
 * in-flight button keeps its own label — it is doing the thing it says.
 */
export function ActionButton({
  onAction,
  className = "btn",
  children,
  disabled,
  progress,
  waitLabel,
  ...rest
}){
  const ref = useRef(null);
  const busy = useRef(false);
  /* In flight is the same shape of "not ready" as a challenge window, so it
     gets the same bar rather than a spinner. The wait has no known length —
     it is a transaction — so it sweeps. */
  const [inFlight, setInFlight] = useState(false);

  const frac = typeof progress === "number" ? Math.min(1, Math.max(0, progress)) : 0;
  /* Gated: something outside this button has to happen first. Separate from
     in-flight because only this transition earns the unlock pulse — firing it
     when a transaction finishes would say "you may press this now" about a
     button that has just been pressed. */
  const gated = progress === "pending" || (typeof progress === "number" && frac < 1);
  const waiting = gated || inFlight;
  const pending = progress === "pending" || inFlight;

  /* A click can advance the beat, which unmounts this button before the
     handler resolves. Without the guard the finally block sets state on a
     component that is gone. */
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  /* Pulse once on the transition into usable, not on every render that happens
     to be unlocked — otherwise a 1s countdown tick re-fires it forever. */
  const [justUnlocked, setJustUnlocked] = useState(false);
  const wasGated = useRef(gated);
  useEffect(() => {
    if (wasGated.current && !gated) {
      wasGated.current = gated;
      setJustUnlocked(true);
      const t = setTimeout(() => setJustUnlocked(false), 1100);
      return () => clearTimeout(t);
    }
    wasGated.current = gated;
    return undefined;
  }, [gated]);

  async function handle(e){
    if (busy.current) return;
    busy.current = true;
    setInFlight(true);
    const node = ref.current;
    try{
      await onAction?.(e, node);
    }finally{
      busy.current = false;
      if (mounted.current) setInFlight(false);
    }
  }

  const cls = [
    className,
    waiting ? "waiting" : "",
    pending ? "pending" : "",
    inFlight ? "busy" : "",
    justUnlocked ? "unlocked" : "",
  ].filter(Boolean).join(" ");

  return (
    <button
      ref={ref}
      className={cls}
      onClick={handle}
      disabled={disabled || waiting}
      /* The label swaps under people using a screen reader as well, so the
         countdown is not a purely visual affordance. */
      aria-busy={waiting || undefined}
      {...rest}
    >
      {waiting ? (
        <span
          className="fill"
          aria-hidden="true"
          style={pending ? undefined : { transform: `scaleX(${frac})` }}
        />
      ) : null}
      {/* waitLabel describes the thing being waited FOR, so it belongs to the
          gated state only. Showing it during the click's own transaction would
          caption the button with a wait that is already over. */}
      <span className="btxt">{gated && waitLabel ? waitLabel : children}</span>
    </button>
  );
}
