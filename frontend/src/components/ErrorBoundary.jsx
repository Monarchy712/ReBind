/* ======================================================= ErrorBoundary.jsx
   A render error anywhere in the tree unmounts the whole React app and leaves
   a blank white page — the single worst thing that can happen while this is
   being demonstrated to a room. Catch it, keep the shell, and show something
   that says what broke and how to get moving again.

   Class component because that is still the only way to implement
   componentDidCatch; there is no hook equivalent.
   ====================================================================== */

import { Component } from "react";

export default class ErrorBoundary extends Component {
  constructor(props){
    super(props);
    this.state = { error:null };
  }

  static getDerivedStateFromError(error){
    return { error };
  }

  componentDidCatch(error, info){
    // Keep the detail in the console for whoever is debugging afterwards.
    console.error("Rebind UI crashed:", error, info?.componentStack);
  }

  render(){
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="view page">
        <div className="wrap">
          <div className="section-head">
            <span className="kicker">something broke</span>
            <h2 className="display">
              this screen failed to render.{" "}
              <span className="fade">the chain is untouched.</span>
            </h2>
          </div>

          <div className="banner">
            <span className="ico">err</span>
            <div>
              <b>{error?.name || "Error"}</b>
              <p>{error?.message || String(error)}</p>
            </div>
          </div>

          <p className="hint" style={{ marginBottom:22 }}>
            This is a display failure, not a transaction failure — nothing was
            sent on your behalf. Reloading re-reads the current state from the
            chain and picks the flow back up where it actually is.
          </p>

          <div className="row" style={{ gap:10, flexWrap:"wrap" }}>
            <button className="btn primary" onClick={() => window.location.reload()}>
              reload the app
            </button>
            <button
              className="btn"
              onClick={() => { window.location.hash = "#/"; this.setState({ error:null }); }}
            >
              back to overview
            </button>
          </div>
        </div>
      </div>
    );
  }
}
