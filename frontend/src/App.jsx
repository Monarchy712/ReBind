/* ================================================================ App.jsx
   Shell: fixed nav, routed outlet, footer. Hash routing, because
   express.static has no catch-all and a path route would 404 on a hard
   refresh of /console in production.
   ====================================================================== */

import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";

import { useRebind } from "./store/RebindProvider.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import Landing from "./routes/Landing.jsx";
import Demo from "./routes/Demo.jsx";
import Console from "./routes/Console.jsx";
import Recover from "./routes/Recover.jsx";

const TITLES = {
  "/":"Recovery infrastructure for permissioned assets",
  "/demo":"Live demo",
  "/console":"Issuer console",
  "/recover":"Start a recovery",
};

function Nav(){
  const [open, setOpen] = useState(false);
  const link = ({ isActive }) => (isActive ? "on" : undefined);

  return (
    <header className="nav">
      <div className="wrap nav-inner">
        <NavLink className="brand" to="/" onClick={() => setOpen(false)}>
          <span className="mark">
            {/* Two opposed hourglasses: the old key and the new, one identity. */}
            <svg viewBox="0 0 32 32" aria-hidden="true">
              <path d="M4 6h11l-5.5 10L15 26H4l5.5-10z" fill="currentColor" />
              <path d="M17 6h11l-5.5 10L28 26H17l5.5-10z" fill="currentColor" />
            </svg>
          </span>
          <span><span className="name">rebind</span></span>
          <span className="sup">rwa</span>
        </NavLink>

        <nav className={`routes${open ? " open" : ""}`} aria-label="Primary" onClick={() => setOpen(false)}>
          <NavLink to="/" end className={link}>Overview</NavLink>
          <NavLink to="/demo" className={link}>Demo</NavLink>
          <NavLink to="/recover" className={link}>Recover</NavLink>
          <NavLink to="/console" className={link}>Console →</NavLink>
        </nav>

        <button className="navburger" type="button" aria-label="Menu" onClick={() => setOpen((o) => !o)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 7h18M3 17h18" />
          </svg>
        </button>
      </div>
    </header>
  );
}

function Footer(){
  const { online, localMode, contracts, config } = useRebind();
  const mode = !online
    ? "backend offline"
    : localMode
      ? "local demo mode"
      : contracts ? `chain ${contracts.chainId}` : config ? `chain ${config.chainId}` : "connecting";

  return (
    <footer className="foot">
      <div className="wrap foot-inner">
        <span className="tag">ERC-1404</span>
        <span className="tag">EIP-712</span>
        <span className="tag">Cleanverse A-Pass</span>
        <span className="tag">{mode}</span>
        <span className="lbl dim" style={{ marginLeft:"auto" }}>
          recovery infrastructure for permissioned assets
        </span>
      </div>
    </footer>
  );
}

export default function App(){
  const { pathname } = useLocation();

  /* The nav sits over the landing hero's dark band and over bone everywhere
     else, so its type has to invert at exactly the band's lower edge. */
  useEffect(() => {
    const sync = () => {
      const hero = document.querySelector(".hero");
      document.body.classList.toggle("nav-dark", !!hero && window.scrollY < hero.offsetHeight - 70);
      document.body.classList.toggle("scrolled", window.scrollY > 8);
    };
    sync();
    window.addEventListener("scroll", sync, { passive:true });
    // Route changes swap the hero in and out, so re-evaluate after paint.
    const t = setTimeout(sync, 60);
    return () => { window.removeEventListener("scroll", sync); clearTimeout(t); };
  }, [pathname]);

  useEffect(() => {
    document.title = pathname === "/" ? "Rebind — identity outlives the key" : `${TITLES[pathname] || "Rebind"} · Rebind`;
    window.scrollTo({ top:0, behavior:"instant" });
  }, [pathname]);

  return (
    <div id="app">
      <Nav />
      <main>
        {/* Keyed on the route so recovering from an error on one screen does
            not keep the error state pinned when you navigate to another. */}
        <ErrorBoundary key={pathname}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/demo" element={<Demo />} />
          <Route path="/console" element={<Console />} />
          <Route path="/recover" element={<Recover />} />
          <Route path="*" element={<Landing />} />
        </Routes>
        </ErrorBoundary>
      </main>
      <Footer />
    </div>
  );
}
