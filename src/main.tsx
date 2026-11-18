import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter/index.css";
import { Tooltip } from "radix-ui";
import RealApp from "./RealApp";
import { SessionBoundary } from "./SessionBoundary";
import "./styles.css";
import "./themes/odysseus.css";
import "./connections.css";

// The session-only design prototype is a development aid: release builds leave it out entirely.
const PrototypeApp =
  import.meta.env.VITE_COHERENCE_RELEASE !== "1" &&
  new URLSearchParams(window.location.search).has("prototype")
    ? lazy(() => import("./App"))
    : null;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Tooltip.Provider delayDuration={350} skipDelayDuration={100}>
      {PrototypeApp ? (
        <Suspense fallback={null}>
          <PrototypeApp />
        </Suspense>
      ) : (
        <SessionBoundary>
          <RealApp />
        </SessionBoundary>
      )}
    </Tooltip.Provider>
  </React.StrictMode>,
);
