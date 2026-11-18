import { useEffect, useRef, useState, type ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { Dialog } from "radix-ui";
import {
  SESSION_CHANGED_EVENT,
  SESSION_REQUIRED_EVENT,
  isLiteralLoopbackOrigin,
} from "../shared/localAuth";
import { checkSession } from "./localSession";
import { Button } from "./ui";
import { SessionAuthorization } from "./sessionAuthorization";

/** Keep an already-open editor mounted when a session expires: do not erase unsaved human edits. */
export function SessionBoundary({ children }: { children: ReactNode }) {
  const literalAddress = isLiteralLoopbackOrigin(window.location.origin);
  const [started, setStarted] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [checking, setChecking] = useState(true);
  const attempt = useRef(0);
  async function reconnect() {
    const current = ++attempt.current;
    setChecking(true);
    const ok = await checkSession();
    if (current !== attempt.current) return;
    setAuthorized(ok);
    if (ok) setStarted(true);
    setChecking(false);
  }
  useEffect(() => {
    void reconnect();
    const expired = () => {
      attempt.current++;
      setChecking(false);
      setAuthorized(false);
    };
    const changed = () => {
      void reconnect();
    };
    window.addEventListener(SESSION_REQUIRED_EVENT, expired);
    window.addEventListener("storage", changed);
    // A separate launcher tab updates origin storage. Re-check on returning to this tab.
    window.addEventListener("focus", changed);
    return () => {
      attempt.current++;
      window.removeEventListener(SESSION_REQUIRED_EVENT, expired);
      window.removeEventListener("storage", changed);
      window.removeEventListener("focus", changed);
    };
  }, []);
  useEffect(() => {
    if (authorized) window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
  }, [authorized]);
  return (
    <>
      {started && (
        <SessionAuthorization.Provider value={authorized}>
          <div style={{ display: "contents" }} inert={!authorized}>
            {children}
          </div>
        </SessionAuthorization.Provider>
      )}
      <Dialog.Root open={!authorized}>
        <Dialog.Portal>
          <Dialog.Overlay className="session-overlay">
            <Dialog.Content
              className="real-panel session-card"
              aria-label="Local session required"
              aria-labelledby={undefined}
              aria-describedby="session-help"
              onEscapeKeyDown={(e) => e.preventDefault()}
              onInteractOutside={(e) => e.preventDefault()}
            >
              <ShieldCheck size={32} />
              <p className="eyebrow">YOUR PRIVATE LOCAL WORKSPACE</p>
              <Dialog.Title asChild>
                <h1>
                  {checking
                    ? "Connecting securely…"
                    : "Open your local session."}
                </h1>
              </Dialog.Title>
              <p id="session-help">
                {import.meta.env.VITE_COHERENCE_RELEASE === "1" ? (
                  <>
                    Open Coherence again from the Start menu, then choose
                    Reconnect. It opens a verified session without a password.
                  </>
                ) : (
                  <>
                    Start Coherence, then run <code>npm run open:dev</code> for
                    development or <code>npm run open</code> for the built app.
                    The launcher opens a verified session without a password.
                  </>
                )}
                {!literalAddress &&
                  " This tab uses an unsupported address. The launcher opens 127.0.0.1; hostname sessions cannot be transferred or reconnected here."}
              </p>
              <p className="muted">
                Sessions last up to 12 hours and end when the server restarts.{" "}
                {started
                  ? "Your unsaved edits are still in this tab. After reopening, reconnect here without refreshing."
                  : "Visiting this address alone does not grant access to your projects."}
              </p>
              <Button
                variant="primary"
                disabled={checking || !literalAddress}
                onClick={() => void reconnect()}
              >
                Reconnect this tab
              </Button>
            </Dialog.Content>
          </Dialog.Overlay>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
