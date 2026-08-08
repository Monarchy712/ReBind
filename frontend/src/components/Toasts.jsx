/* ============================================================= Toasts.jsx
   Toast host + the useToast() hook. The vanilla build appended nodes to the
   document directly; here the queue is state and React owns the DOM, but the
   markup and classes are identical so app.css needs no change.
   ====================================================================== */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

const Ctx = createContext(() => {});
export const useToast = () => useContext(Ctx);

const TAG = { ok:"ok", err:"err", warn:"warn", info:"log" };

export function ToastProvider({ children }){
  const [items, setItems] = useState([]);
  const idRef = useRef(0);
  const timers = useRef(new Set());

  const remove = useCallback((id) => {
    setItems((list) => list.map((t) => (t.id === id ? { ...t, out:true } : t)));
    const t = setTimeout(
      () => setItems((list) => list.filter((x) => x.id !== id)),
      320,
    );
    timers.current.add(t);
  }, []);

  const toast = useCallback((message, { title, kind = "info", ms = 4200 } = {}) => {
    const id = ++idRef.current;
    setItems((list) => [...list, { id, message, title, kind }]);
    const t = setTimeout(() => remove(id), ms);
    timers.current.add(t);
    return id;
  }, [remove]);

  // Timers outlive the component that scheduled them, so they are cleared as a
  // set rather than per-toast.
  useEffect(() => {
    const set = timers.current;
    return () => { set.forEach(clearTimeout); set.clear(); };
  }, []);

  return (
    <Ctx.Provider value={toast}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}${t.out ? " out" : ""}`}>
            <span className="ico">{TAG[t.kind] || "log"}</span>
            <div>
              {t.title ? <b>{t.title}</b> : null}
              <span>{t.message}</span>
            </div>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
