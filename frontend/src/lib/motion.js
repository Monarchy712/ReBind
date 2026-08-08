/* =============================================================== motion.js
   The imperative half of the motion system. React owns what is on screen;
   these own the one-shot flourishes that are genuinely about DOM nodes —
   a card recoiling, value flying between two elements, a number counting up.

   Everything here is decoration over state the DOM already carries, so
   honouring the reduced-motion preference is a single check rather than a
   rule repeated in every component.
   ====================================================================== */

export const REDUCED =
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Adds a class, restarts its animation, then removes it. Takes a node or ref. */
export function once(target, cls, ms){
  const node = target?.current ?? target;
  if (!node || REDUCED) return;
  node.classList.remove(cls);
  void node.offsetWidth;              // restart on repeat triggers
  node.classList.add(cls);
  setTimeout(() => node.classList.remove(cls), ms);
}

/** Sends a labelled chip arcing from one element to another, leaving a pulse
 *  ring behind at the origin. Two hops so the path curves — a straight linear
 *  slide reads as a tooltip moving rather than value in flight. */
export function flyValue(fromEl, toEl, label){
  const a0 = fromEl?.current ?? fromEl;
  const b0 = toEl?.current ?? toEl;
  if (!a0 || !b0 || REDUCED) return;

  const a = a0.getBoundingClientRect();
  const b = b0.getBoundingClientRect();

  const ring = document.createElement("div");
  ring.className = "flypulse";
  Object.assign(ring.style, {
    left:`${a.left}px`, top:`${a.top}px`, width:`${a.width}px`, height:`${a.height}px`,
  });
  document.body.append(ring);
  setTimeout(() => ring.remove(), 950);

  const chip = document.createElement("div");
  chip.className = "flyer";
  chip.textContent = label;

  const at = (x, y, scale, rot = 0) =>
    `translate(${x}px,${y}px) translate(-50%,-50%) scale(${scale}) rotate(${rot}deg)`;

  const x0 = a.left + a.width / 2, y0 = a.top + a.height / 2;
  const x1 = b.left + b.width / 2, y1 = b.top + b.height / 2;
  const xm = (x0 + x1) / 2;
  const ym = Math.min(y0, y1) - Math.max(90, Math.abs(y1 - y0) * 0.45);

  chip.style.transform = at(x0, y0, 0.6, -6);
  chip.style.opacity = "0";
  document.body.append(chip);

  requestAnimationFrame(() => {
    chip.style.transition = "transform .55s cubic-bezier(.2,.7,.4,1), opacity .3s ease";
    chip.style.opacity = "1";
    chip.style.transform = at(xm, ym, 1.18, 4);
  });
  setTimeout(() => {
    chip.style.transition = "transform .6s cubic-bezier(.55,0,.7,1), opacity .35s ease";
    chip.style.transform = at(x1, y1, 0.92, -3);
  }, 560);

  setTimeout(() => { chip.style.opacity = "0"; }, 1180);
  setTimeout(() => chip.remove(), 1650);
}

/** Counts a number up to its new value. */
export function countTo(target, to, { duration = 700, format = (n) => n.toLocaleString() } = {}){
  const node = target?.current ?? target;
  if (!node) return;
  const from = Number(String(node.dataset.v || 0).replace(/,/g, "")) || 0;
  node.dataset.v = to;
  if (REDUCED || from === to){ node.textContent = format(to); return; }
  const t0 = performance.now();
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    node.textContent = format(Math.round(from + (to - from) * eased));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
