import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, Pause, Play, Plus } from "lucide-react";
import { Button } from "./ui";
import { mountHeroMotion } from "./homeHeroMotion";
import "./homeHero.css";

/** Responsive adaptation of the owner's supplied Hero5a.tsx, not the preview runtime. */
export function HomeHero({
  hasProjects,
  onNewProject,
  onDemo,
  busy = false,
  paused = false,
  staticMode = false,
}: {
  hasProjects: boolean;
  onNewProject: () => void;
  onDemo: () => void;
  busy?: boolean;
  paused?: boolean;
  staticMode?: boolean;
}) {
  const root = useRef<HTMLElement>(null);
  const [playing, setPlaying] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const [systemReduced, setSystemReduced] = useState(
    () =>
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false,
  );
  const annotationId = useId();
  const motionHelpId = useId();
  useEffect(() => {
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = () => setSystemReduced(preference?.matches ?? false);
    update();
    preference?.addEventListener("change", update);
    return () => preference?.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    const begin = () => {
      if (!disposed && root.current)
        cleanup = mountHeroMotion(root.current, setPlaying, {
          paused: paused || userPaused,
          staticMode,
        });
    };
    // Start the loop after the locally bundled fonts are ready.
    if (
      !paused &&
      !userPaused &&
      !staticMode &&
      document.fonts?.load &&
      !window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches &&
      document.documentElement.dataset.motion !== "reduced"
    ) {
      void Promise.allSettled([
        document.fonts.load('500 20px "Geist Variable"'),
        document.fonts.load('400 12px "Geist Mono Variable"'),
        document.fonts.load('italic 400 20px "Instrument Serif"'),
      ])
        .then(() => document.fonts.ready)
        .then(begin, begin);
    } else begin();
    return () => {
      disposed = true;
      cleanup();
    };
  }, [paused, staticMode, userPaused]);
  const motionControl = (
    <button
      type="button"
      className="hero5a-motion-control"
      onClick={() => setUserPaused((value) => !value)}
      disabled={paused || staticMode || systemReduced}
      aria-describedby={motionHelpId}
    >
      {userPaused ? <Play size={11} /> : <Pause size={11} />}
      {paused || staticMode || systemReduced
        ? "Animation paused"
        : userPaused
          ? "Resume animation"
          : "Pause animation"}
    </button>
  );
  return (
    <section
      ref={root}
      className={`home-hero hero5a ${hasProjects ? "hero5a-compact" : "hero5a-welcome"}`}
      aria-label={
        hasProjects
          ? "From screens to shared understanding"
          : "Welcome to Coherence"
      }
      data-motion={playing ? "playing" : "complete"}
      data-paused={paused || userPaused || undefined}
      data-static={staticMode || undefined}
    >
      <div className="hero5a-copy">
        <h2>
          From scattered screens to <em>shared understanding.</em>
        </h2>
        <p className="hero5a-description">
          {hasProjects ? (
            "Keep the evidence close. Make the next decision clear."
          ) : (
            <>
              <strong className="hero5a-description-lead">
                Screenshots in. AI connects the dots.
              </strong>
              <span>
                Let AI surface the gaps, draft use cases and business rules, and
                turn the chaos into editable, export-ready specs.
              </span>
            </>
          )}
        </p>
        {hasProjects && (
          <div className="hero5a-caption">
            <p className="hero5a-example">Fictional ACME example</p>
            {motionControl}
          </div>
        )}
        {!hasProjects && (
          <>
            <div className="hero5a-actions">
              <Button
                onClick={onNewProject}
                disabled={busy}
                className="hero5a-new"
              >
                <Plus size={17} />
                New project
              </Button>
              <div className="hero5a-demo-group">
                <Button
                  onClick={onDemo}
                  disabled={busy}
                  className="hero5a-demo"
                  aria-describedby={annotationId}
                >
                  <span className="hero5a-demo-dot" />
                  Try offline demo
                  <ArrowRight size={15} />
                </Button>
                <svg
                  className="hero5a-demo-arrow"
                  viewBox="0 0 32 28"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M30 26 Q11 25 12 1 M6 8 L12 1 L18 8" />
                </svg>
                <p className="hero5a-annotation" id={annotationId}>
                  No API key. No sign-up. Just try it.
                </p>
              </div>
            </div>
            <div className="hero5a-footer">
              <p className="hero5a-footnote">
                Runs locally <span>·</span> Outputs plain .md <span>·</span>{" "}
                Offline demo uses simulated analysis
              </p>
              {motionControl}
            </div>
          </>
        )}
      </div>
      <p className="hero5a-sr-only" id={motionHelpId}>
        System and Appearance reduced-motion preferences always take priority.
        Pausing displays the complete illustration.
      </p>
      <p className="hero5a-sr-only">
        Illustrative ACME Orders story: scattered screenshots and notes become a
        reviewed order specification. Over the credit limit, an order goes on
        credit hold. The illustrated use case and saved file are fictional, not
        live project results.
      </p>
      <div className="hero5a-art" aria-hidden="true">
        <svg
          className="hero5a-traces"
          viewBox="0 0 520 360"
          preserveAspectRatio="none"
          focusable="false"
        >
          <g fill="none" stroke="currentColor" strokeWidth="1">
            <path d="M74 53 H145 V137 H198 M142 124 H162 V157 H198 M110 219 H153 V183 H198 M132 300 H175 V207 H198 M356 0 V36 M380 326 V360 M474 142 H496 V86 H520 M474 218 H506 V294 H520" />
            <path className="hero5a-copper" d="M72 180 H198 M474 180 H520" />
          </g>
          <g fill="currentColor">
            <circle cx="74" cy="53" r="2" />
            <circle cx="142" cy="124" r="2" />
            <circle cx="110" cy="219" r="2" />
            <circle cx="132" cy="300" r="2" />
            <circle cx="356" cy="36" r="2" />
          </g>
          <circle className="hero5a-signal hero5a-signal-a" r="2.5" />
          <circle className="hero5a-signal hero5a-signal-b" r="2.5" />
          <circle className="hero5a-signal hero5a-signal-c" r="2.5" />
          <circle className="hero5a-signal hero5a-signal-d" r="2.5" />
        </svg>
        <div className="hero5a-fragment hero5a-screen">
          <span>04-new-order.png</span>
          <i />
        </div>
        <div className="hero5a-fragment hero5a-note">credit?? ask finance</div>
        <div className="hero5a-fragment hero5a-sheet">limits_v2_FINAL.xlsx</div>
        <div className="hero5a-fragment hero5a-email">
          re: fwd: re: order limits
        </div>
        <div className="hero5a-fragment hero5a-whiteboard">
          <span>whiteboard.jpg</span>
          <i />
        </div>
        <div className="hero5a-frame">
          <div className="hero5a-story">
            <div className="hero5a-case">
              <b>UC-007</b>
              <span>Review &amp; submit order</span>
            </div>
            <div className="hero5a-row hero5a-rule">
              <small>rule</small>
              <span>
                Over limit <strong>→</strong> Credit hold
              </span>
            </div>
            <div className="hero5a-question">
              <b>?</b>What if credit runs out?
              <i />
            </div>
            <div className="hero5a-facts">
              <div className="hero5a-row hero5a-role">
                <small>role</small>
                <span>Sales rep</span>
              </div>
              <div className="hero5a-row hero5a-test">
                <small>test</small>
                <span>Credit limit exceeded</span>
                <b>✓</b>
              </div>
            </div>
            <div className="hero5a-saved">
              <span>order-spec.md</span>
              <span>● saved</span>
            </div>
          </div>
          <div className="hero5a-scan" />
        </div>
      </div>
    </section>
  );
}
