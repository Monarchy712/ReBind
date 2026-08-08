/* ============================================================= Reveal.jsx
   Scroll reveals and the masked headline, as components.

   Both carry the same hard rule the vanilla build learned twice: an element
   that starts invisible must never depend on a callback that might not run.
   IntersectionObserver can be defeated by a clipping ancestor, and
   requestAnimationFrame does not fire at all in a background tab — either one
   would leave real content stuck at opacity 0 or parked outside its mask.
   So both have an unconditional fallback.
   ====================================================================== */

import { useEffect, useRef, useState } from "react";
import { REDUCED } from "../lib/motion.js";

/** `innerRef` hands the same node back to the caller. Callers need it for the
 *  imperative flourishes (a stage cascade, a guardian pulse) that act on the
 *  revealed element itself — wrapping those in an extra div would break the
 *  `.stage.enter > *` cascade, which selects direct children. */
export function Reveal({ as:Tag = "div", delay = 0, className = "", style, innerRef, children, ...rest }){
  const ref = useRef(null);
  const [shown, setShown] = useState(REDUCED);

  const setNode = (node) => {
    ref.current = node;
    if (typeof innerRef === "function") innerRef(node);
    else if (innerRef) innerRef.current = node;
  };

  useEffect(() => {
    if (shown) return undefined;
    const node = ref.current;
    if (!node || !("IntersectionObserver" in window)){ setShown(true); return undefined; }

    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)){ setShown(true); io.disconnect(); }
    }, { rootMargin:"0px 0px -10% 0px", threshold:0.06 });
    io.observe(node);

    // Safety net: whatever has not revealed a few seconds in gets shown.
    const t = setTimeout(() => setShown(true), 4000);
    return () => { io.disconnect(); clearTimeout(t); };
  }, [shown]);

  return (
    <Tag
      ref={setNode}
      className={`reveal${shown ? " in" : ""}${className ? ` ${className}` : ""}`}
      style={{ "--d":`${delay}ms`, ...style }}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/** A heading whose lines ride up from behind their own clipping masks.
 *  `lines` is an array of strings, or {text, fade} for the dropped-back half. */
export function MaskHeading({ as:Tag = "h1", lines, className = "", stagger = 110, ...rest }){
  const [shown, setShown] = useState(false);

  // Set synchronously after mount rather than inside requestAnimationFrame:
  // these lines start fully outside their mask, so an rAF that never fires
  // (background tab) would leave the headline permanently invisible.
  useEffect(() => { setShown(true); }, []);

  return (
    <Tag className={`display ${className}`} {...rest}>
      {lines.map((line, i) => {
        const text = typeof line === "string" ? line : line.text;
        const fade = typeof line === "string" ? false : line.fade;
        return (
          <span
            key={i}
            className={`maskline${shown ? " in" : ""}`}
            style={{ "--d":`${i * stagger}ms` }}
          >
            <span className={fade ? "fade" : undefined}>{text}</span>
          </span>
        );
      })}
    </Tag>
  );
}
