import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";

import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";

import App from "./App.jsx";
import { RebindProvider } from "./store/RebindProvider.jsx";
import { ToastProvider } from "./components/Toasts.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <HashRouter>
      <ToastProvider>
        <RebindProvider>
          {/* Three drifting blobs under a hairline grid — base.css styles the
              <i> children individually, so all three have to be present. */}
          <div className="ambience" aria-hidden="true"><i /><i /><i /></div>
          <App />
        </RebindProvider>
      </ToastProvider>
    </HashRouter>
  </StrictMode>,
);
