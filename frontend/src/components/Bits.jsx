/* =============================================================== Bits.jsx
   The small shared pieces: offline banner, status chip, countdown ring,
   the beat rail, and the busy-button wrapper. All render exactly the class
   names app.css already defines.
   ====================================================================== */

import { useRef } from "react";
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

/** A button that shows a spinner while its async handler is in flight, and
 *  cannot be double-fired — every one of these sends a transaction. */
export function ActionButton({ onAction, className = "btn", children, disabled, ...rest }){
  const ref = useRef(null);
  const busy = useRef(false);

  async function handle(e){
    if (busy.current) return;
    busy.current = true;
    const node = ref.current;
    node?.classList.add("busy");
    try{
      await onAction?.(e, node);
    }finally{
      busy.current = false;
      node?.classList.remove("busy");
    }
  }

  return (
    <button ref={ref} className={className} onClick={handle} disabled={disabled} {...rest}>
      {children}
    </button>
  );
}
