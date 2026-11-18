// Adapted from Odysseus, AGPL-3.0, revision 8877273e195a90d51bc6a37f3a1b60dc3414c431.
// Owner cleared source incorporation on 22 October 2026. See docs/ODYSSEUS_THEME_PORT.md and public/notices/Odysseus-AGPL-3.0.txt.
export function mountOriginalEffect(pattern, host, animated) {
  const nativeWindow = globalThis.window;
  const nativeDocument = nativeWindow.document;
  const frames = new Set();
  const listeners = new Set();
  let disposed = false;
  let initialFrame = true;
  // Instance-local adapters; never patch browser globals. Original algorithms below
  // keep their palette, geometry, counts, timing and random distributions intact.
  const window = {
    get innerWidth() {
      return nativeWindow.innerWidth;
    },
    get innerHeight() {
      return nativeWindow.innerHeight;
    },
    get devicePixelRatio() {
      return nativeWindow.devicePixelRatio;
    },
    addEventListener(type, listener) {
      nativeWindow.addEventListener(type, listener);
      listeners.add(listener);
    },
    removeEventListener(type, listener) {
      nativeWindow.removeEventListener(type, listener);
      listeners.delete(listener);
    },
  };
  const document = {
    documentElement: nativeDocument.documentElement,
    body: host,
    createElement: (tag) => nativeDocument.createElement(tag),
    getElementById: (id) => host.querySelector(`#${id}`),
  };
  const getComputedStyle = (node) => nativeWindow.getComputedStyle(node);
  const requestAnimationFrame = (callback) => {
    if (disposed || (!animated && !initialFrame)) return 0;
    initialFrame = false;
    const id = nativeWindow.requestAnimationFrame((now) => {
      frames.delete(id);
      if (!disposed) {
        try {
          callback(animated ? now : Math.max(now, 100));
        } catch {
          unavailable();
        }
      }
    });
    frames.add(id);
    return id;
  };
  const cleanup = () => {
    disposed = true;
    for (const id of frames) nativeWindow.cancelAnimationFrame(id);
    frames.clear();
    for (const listener of listeners)
      nativeWindow.removeEventListener("resize", listener);
    listeners.clear();
    host.replaceChildren();
  };
  const initializers = {
    synapse: _initSynapse,
    "starfield-depth": _initStarfieldDepth,
    "ascii-fireflies": _initAsciiFireflies,
    petals: _initPetals,
    sparkles: _initSparkles,
    embers: _initEmbers,
  };
  const unavailable = () => {
    cleanup();
    host.dataset.fallback = "unavailable";
    host.dataset.motion = "static";
  };
  try {
    initializers[pattern]?.();
  } catch {
    unavailable();
  }
  return cleanup;

  function hexToRgb(hex) {
    let h = String(hex || "")
      .trim()
      .replace(/^#/, "");
    if (h.length === 3)
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function _getEffectSize() {
    const v = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--bg-effect-size",
      ),
    );
    return isNaN(v) ? 1 : v;
  }
  function _getEffectSpeed() {
    const v = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--bg-effect-speed",
      ),
    );
    return isNaN(v) ? 1 : v;
  }
  function _initSynapse() {
    if (document.getElementById("synapse-canvas")) return;
    const canvas = document.createElement("canvas");
    canvas.id = "synapse-canvas";
    canvas.style.cssText =
      "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;";
    // Decorative background effect — hide from assistive tech so screen readers
    // don't announce an empty canvas and axe's "region" rule doesn't flag it.
    canvas.setAttribute("aria-hidden", "true");
    document.body.prepend(canvas);
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const GRID = 24; // matches CSS grid size
    const MAX_PULSES = 20;
    const SPEED_MIN = 2;
    const SPEED_MAX = 22;
    const TRAIL_LEN = 12; // pixels of trailing glow

    let W,
      H,
      cols,
      rows,
      pulses = [];

    function resize() {
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(W / GRID);
      rows = Math.ceil(H / GRID);
    }
    resize();
    const _onResize = () => resize();
    window.addEventListener("resize", _onResize);

    function getColor() {
      const s = getComputedStyle(document.documentElement);
      return (
        s.getPropertyValue("--bg-effect-color").trim() ||
        s.getPropertyValue("--fg").trim() ||
        "#9cdef2"
      );
    }

    function spawnPulse() {
      const speed = SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN);
      if (Math.random() > 0.5) {
        // Horizontal — pick a grid row
        const row = Math.floor(Math.random() * (rows + 1));
        pulses.push({ x: -TRAIL_LEN, y: row * GRID, dx: speed, dy: 0 });
      } else {
        // Vertical — pick a grid column
        const col = Math.floor(Math.random() * (cols + 1));
        pulses.push({ x: col * GRID, y: -TRAIL_LEN, dx: 0, dy: speed });
      }
    }

    function draw() {
      if (
        !document.body.classList.contains("bg-pattern-synapse") ||
        document.body.classList.contains("memory-disabled")
      ) {
        window.removeEventListener("resize", _onResize);
        canvas.remove();
        return;
      }
      requestAnimationFrame(draw);
      ctx.clearRect(0, 0, W, H);
      const c = getColor();

      // Spawn
      if (pulses.length < MAX_PULSES && Math.random() < 0.12) spawnPulse();

      // Draw pulses as small bright dots with a short trail
      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i];
        const speedMult = _getEffectSpeed();
        p.x += p.dx * speedMult;
        p.y += p.dy * speedMult;

        // Off screen — remove
        if (p.x > W + TRAIL_LEN || p.y > H + TRAIL_LEN) {
          pulses.splice(i, 1);
          continue;
        }

        // Trail (line gradient fading behind the dot)
        const tx = p.x - (p.dx > 0 ? TRAIL_LEN : 0);
        const ty = p.y - (p.dy > 0 ? TRAIL_LEN : 0);
        const grad = ctx.createLinearGradient(tx, ty, p.x, p.y);
        grad.addColorStop(0, "transparent");
        grad.addColorStop(1, c);
        ctx.strokeStyle = grad;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();

        // Bright dot at head
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalAlpha = 1;
    }
    draw();
  }

  function _initStarfieldDepth() {
    if (document.getElementById("starfield-depth-canvas")) return;
    const canvas = document.createElement("canvas");
    canvas.id = "starfield-depth-canvas";
    canvas.style.cssText =
      "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:0;";
    canvas.setAttribute("aria-hidden", "true");
    document.body.prepend(canvas);
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0,
      H = 0,
      stars = [];
    const resize = () => {
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!stars.length)
        stars = Array.from({ length: 180 }, () => ({
          x: Math.random() * W,
          y: Math.random() * H,
          z: 0.15 + Math.random() * 0.9,
        }));
    };
    resize();
    window.addEventListener("resize", resize);
    const getBgFade = () => {
      const bg = getComputedStyle(document.documentElement)
        .getPropertyValue("--bg")
        .trim();
      const { r, g, b } = hexToRgb(bg) || { r: 0, g: 0, b: 0 };
      return `rgba(${r},${g},${b},0.72)`;
    };
    const draw = () => {
      if (
        !canvas.isConnected ||
        !document.body.classList.contains("bg-pattern-starfield-depth")
      ) {
        window.removeEventListener("resize", resize);
        canvas.remove();
        return;
      }
      requestAnimationFrame(draw);
      ctx.fillStyle = getBgFade();
      ctx.fillRect(0, 0, W, H);
      const color =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--bg-effect-color")
          .trim() ||
        getComputedStyle(document.documentElement)
          .getPropertyValue("--fg")
          .trim();
      const size = _getEffectSize();
      for (const star of stars) {
        star.y += (0.12 + star.z * 0.8) * size * _getEffectSpeed();
        if (star.y > H + 4) {
          star.y = -4;
          star.x = Math.random() * W;
        }
        ctx.fillStyle = color;
        ctx.globalAlpha =
          (0.1 + star.z * 0.4) *
          (parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue(
              "--bg-effect-intensity",
            ),
          ) || 1);
        ctx.beginPath();
        ctx.arc(star.x, star.y, (0.35 + star.z * 1.3) * size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };
    draw();
  }

  function _initAsciiFireflies() {
    if (document.getElementById("ascii-fireflies-background")) return;
    const output = document.createElement("pre");
    output.id = "ascii-fireflies-background";
    output.setAttribute("aria-hidden", "true");
    document.body.prepend(output);
    const source = document.createElement("canvas");
    const ctx = source.getContext("2d", { willReadFrequently: true });
    const ramp = " .,:;irsXA253hMHGS#9B&@";
    let columns = 0,
      rows = 0,
      flies = [],
      tick = 0,
      lastRender = 0;
    const resize = () => {
      const metrics = document.createElement("span");
      metrics.style.cssText =
        "position:fixed;visibility:hidden;font:12px ui-monospace";
      metrics.textContent = "M";
      document.body.append(metrics);
      const charWidth = metrics.getBoundingClientRect().width || 7;
      metrics.remove();
      columns = Math.max(40, Math.floor((window.innerWidth - 32) / charWidth));
      rows = Math.max(18, Math.floor((window.innerHeight - 28) / 12));
      source.width = columns * 2;
      source.height = rows * 2;
      flies = Array.from(
        { length: Math.min(135, Math.floor(columns * rows * 0.08)) },
        (_, index) => {
          const depth =
            index < Math.min(90, Math.floor(columns * rows * 0.055))
              ? Math.random() * 0.32
              : 0.32 + Math.random() * 0.68;
          return {
            x: Math.random() * source.width,
            y: Math.random() * source.height,
            phase: Math.random() * 7,
            depth,
            drift: 0.02 + depth * 0.42,
            size: 0.4 + depth * 1.7,
          };
        },
      );
    };
    resize();
    window.addEventListener("resize", resize);
    const draw = (now) => {
      if (
        !output.isConnected ||
        !document.body.classList.contains("bg-pattern-ascii-fireflies")
      ) {
        window.removeEventListener("resize", resize);
        output.remove();
        return;
      }
      requestAnimationFrame(draw);
      if (now - lastRender < 66) return;
      lastRender = now;
      tick += _getEffectSpeed();
      const W = source.width,
        H = source.height;
      ctx.fillStyle = "rgb(2,8,4)";
      ctx.fillRect(0, 0, W, H);
      const vortices = [
        {
          x: W * (0.3 + Math.sin(tick * 0.002) * 0.08),
          y: H * (0.42 + Math.cos(tick * 0.0017) * 0.08),
          dir: 1,
        },
        {
          x: W * (0.72 + Math.cos(tick * 0.0015) * 0.06),
          y: H * (0.62 + Math.sin(tick * 0.0022) * 0.07),
          dir: -1,
        },
      ];
      for (const fly of flies) {
        const speed = 0.004 + fly.depth * 0.028;
        fly.x += Math.sin(tick * speed + fly.phase) * fly.drift;
        fly.y += Math.cos(tick * speed * 0.72 + fly.phase) * fly.drift * 0.55;
        for (const vortex of vortices) {
          const dx = fly.x - vortex.x,
            dy = fly.y - vortex.y,
            distance = Math.hypot(dx, dy) || 1;
          const turn =
            Math.max(0, 1 - distance / (W * 0.25)) *
            (0.006 + fly.depth * 0.052) *
            vortex.dir;
          fly.x += (-dy / distance) * turn;
          fly.y += (dx / distance) * turn;
        }
        if (fly.x < 0 || fly.x >= W || fly.y < 0 || fly.y >= H) {
          fly.x = Math.random() * W;
          fly.y = Math.random() * H;
        }
        const pulse =
          (Math.sin(tick * (0.018 + fly.depth * 0.045) + fly.phase) + 1) / 2;
        const brightness = 45 + Math.round((75 + fly.depth * 135) * pulse);
        ctx.fillStyle = `rgb(${brightness},${brightness},${brightness})`;
        ctx.beginPath();
        ctx.arc(fly.x, fly.y, fly.size * (0.7 + pulse * 0.8), 0, Math.PI * 2);
        ctx.fill();
      }
      const pixels = ctx.getImageData(0, 0, W, H).data;
      const lines = [];
      for (let y = 0; y < rows; y++) {
        let line = "";
        for (let x = 0; x < columns; x++) {
          let luminosity = 0;
          for (let sampleY = 0; sampleY < 2; sampleY++)
            for (let sampleX = 0; sampleX < 2; sampleX++)
              luminosity +=
                pixels[((y * 2 + sampleY) * W + x * 2 + sampleX) * 4];
          luminosity /= 4;
          line +=
            ramp[
              Math.min(
                ramp.length - 1,
                Math.floor((luminosity / 256) * ramp.length),
              )
            ];
        }
        lines.push(line);
      }
      output.textContent = lines.join("\n");
    };
    requestAnimationFrame(draw);
  }

  function _initPetals() {
    if (document.getElementById("petals-canvas")) return;
    const canvas = document.createElement("canvas");
    canvas.id = "petals-canvas";
    canvas.style.cssText =
      "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;";
    // Decorative background effect — hide from assistive tech so screen readers
    // don't announce an empty canvas and axe's "region" rule doesn't flag it.
    canvas.setAttribute("aria-hidden", "true");
    document.body.prepend(canvas);
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W, H;
    const petals = [];
    function makePetal() {
      return {
        x: Math.random() * W,
        y: -10 - Math.random() * 40,
        size: 3 + Math.random() * 5,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.03,
        vy: 0.3 + Math.random() * 0.6,
        drift: Math.random() * Math.PI * 2,
        driftSpeed: 0.008 + Math.random() * 0.012,
        wobble: 0.3 + Math.random() * 0.8,
      };
    }
    function resize() {
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (petals.length === 0)
        for (let i = 0; i < 30; i++) {
          const p = makePetal();
          p.y = Math.random() * H;
          petals.push(p);
        }
    }
    resize();
    const _onResize = () => resize();
    window.addEventListener("resize", _onResize);
    function getColor() {
      const s = getComputedStyle(document.documentElement);
      return (
        s.getPropertyValue("--bg-effect-color").trim() ||
        s.getPropertyValue("--fg").trim() ||
        "#9cdef2"
      );
    }
    function draw() {
      if (!document.body.classList.contains("bg-pattern-petals")) {
        window.removeEventListener("resize", _onResize);
        canvas.remove();
        return;
      }
      requestAnimationFrame(draw);
      ctx.clearRect(0, 0, W, H);
      const c = getColor();
      const sz = _getEffectSize();
      petals.forEach((p) => {
        const speedMult = _getEffectSpeed();
        p.y += p.vy * speedMult;
        p.rot += p.vr * speedMult;
        p.drift += p.driftSpeed * speedMult;
        p.x += Math.sin(p.drift) * p.wobble * speedMult;
        if (p.y > H + 15) Object.assign(p, makePetal());
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = 0.2;
        // petal shape — two overlapping ellipses
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.ellipse(
          -p.size * 0.2 * sz,
          0,
          p.size * 0.6 * sz,
          p.size * 0.3 * sz,
          0.3,
          0,
          Math.PI * 2,
        );
        ctx.fill();
        ctx.globalAlpha = 0.15;
        ctx.beginPath();
        ctx.ellipse(
          p.size * 0.2 * sz,
          0,
          p.size * 0.6 * sz,
          p.size * 0.3 * sz,
          -0.3,
          0,
          Math.PI * 2,
        );
        ctx.fill();
        ctx.restore();
      });
      ctx.globalAlpha = 1;
    }
    draw();
  }

  function _initSparkles() {
    if (document.getElementById("sparkles-canvas")) return;
    const canvas = document.createElement("canvas");
    canvas.id = "sparkles-canvas";
    canvas.style.cssText =
      "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;";
    // Decorative background effect — hide from assistive tech so screen readers
    // don't announce an empty canvas and axe's "region" rule doesn't flag it.
    canvas.setAttribute("aria-hidden", "true");
    document.body.prepend(canvas);
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W, H;
    const sparkles = [];
    function makeSpark() {
      return {
        x: Math.random() * W,
        y: Math.random() * H,
        size: 2 + Math.random() * 5,
        phase: Math.random() * Math.PI * 2,
        speed: 0.015 + Math.random() * 0.03,
        life: 0.5 + Math.random() * 0.5,
      };
    }
    function resize() {
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (sparkles.length === 0)
        for (let i = 0; i < 35; i++) sparkles.push(makeSpark());
    }
    resize();
    const _onResize = () => resize();
    window.addEventListener("resize", _onResize);
    function getColor() {
      const s = getComputedStyle(document.documentElement);
      return (
        s.getPropertyValue("--bg-effect-color").trim() ||
        s.getPropertyValue("--fg").trim() ||
        "#9cdef2"
      );
    }
    function drawStar(x, y, r, c, alpha) {
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = c;
      ctx.globalAlpha = alpha;
      // 4-point star
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.quadraticCurveTo(r * 0.15, -r * 0.15, r, 0);
      ctx.quadraticCurveTo(r * 0.15, r * 0.15, 0, r);
      ctx.quadraticCurveTo(-r * 0.15, r * 0.15, -r, 0);
      ctx.quadraticCurveTo(-r * 0.15, -r * 0.15, 0, -r);
      ctx.fill();
      ctx.restore();
    }
    function draw() {
      if (!document.body.classList.contains("bg-pattern-sparkles")) {
        window.removeEventListener("resize", _onResize);
        canvas.remove();
        return;
      }
      requestAnimationFrame(draw);
      ctx.clearRect(0, 0, W, H);
      const c = getColor();
      const sizeMult = _getEffectSize();
      sparkles.forEach((s) => {
        s.phase += s.speed * _getEffectSpeed();
        const twinkle = Math.sin(s.phase);
        const alpha = Math.max(0, twinkle) * 0.25 * s.life;
        const scale = 0.5 + Math.max(0, twinkle) * 0.5;
        if (alpha > 0.01)
          drawStar(s.x, s.y, s.size * scale * sizeMult, c, alpha);
        // respawn when cycle completes
        if (s.phase > Math.PI * 6) Object.assign(s, makeSpark());
      });
      ctx.globalAlpha = 1;
    }
    draw();
  }

  function _initEmbers() {
    if (document.getElementById("embers-canvas")) return;
    const canvas = document.createElement("canvas");
    canvas.id = "embers-canvas";
    canvas.style.cssText =
      "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;";
    // Decorative background effect — hide from assistive tech so screen readers
    // don't announce an empty canvas and axe's "region" rule doesn't flag it.
    canvas.setAttribute("aria-hidden", "true");
    document.body.prepend(canvas);
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W, H;
    const embers = [];
    function makeEmber() {
      return {
        x: Math.random() * W,
        y: H + Math.random() * 40,
        vx: (Math.random() - 0.5) * 0.3,
        vy: -0.3 - Math.random() * 0.8,
        r: 0.3 + Math.random() * 0.6,
        life: 0,
        maxLife: 220 + Math.random() * 220,
        wobble: Math.random() * Math.PI * 2,
        spark: false,
      };
    }
    function resize() {
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (embers.length === 0) {
        for (let i = 0; i < 60; i++) {
          const e = makeEmber();
          e.y = Math.random() * H;
          e.life = Math.random() * e.maxLife;
          embers.push(e);
        }
      }
    }
    resize();
    const _onResize = () => resize();
    window.addEventListener("resize", _onResize);
    function getColor() {
      const s = getComputedStyle(document.documentElement);
      return (
        s.getPropertyValue("--bg-effect-color").trim() ||
        s.getPropertyValue("--fg").trim() ||
        "#c9a95a"
      );
    }
    function rgba(hex, a) {
      const { r, g, b } = hexToRgb(hex) || { r: 0, g: 0, b: 0 };
      return `rgba(${r},${g},${b},${a})`;
    }
    function draw() {
      if (!document.body.classList.contains("bg-pattern-embers")) {
        window.removeEventListener("resize", _onResize);
        canvas.remove();
        return;
      }
      requestAnimationFrame(draw);
      // Fade previous frame (destination-out keeps canvas transparent where no embers)
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "lighter";
      const color = getColor();
      for (let i = embers.length - 1; i >= 0; i--) {
        const e = embers[i];
        const speedMult = _getEffectSpeed();
        e.wobble += 0.03 * speedMult;
        e.x += (e.vx + Math.sin(e.wobble) * 0.5) * speedMult;
        e.y += e.vy * speedMult;
        e.life += speedMult;
        if (e.life > e.maxLife || e.y < -20) {
          embers.splice(i, 1);
          if (embers.length < 70) embers.push(makeEmber());
          continue;
        }
        if (!e.spark && Math.random() < 0.003) e.spark = true;
        const lifeRatio = e.life / e.maxLife;
        const fade = Math.min(1, Math.min(lifeRatio * 4, (1 - lifeRatio) * 3));
        const sz = _getEffectSize();
        const r = e.r * (e.spark ? 2.4 : 1) * sz;
        const a = (e.spark ? 0.9 : 0.55) * fade;
        const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, r * 4);
        g.addColorStop(0, rgba(color, a));
        g.addColorStop(0.4, rgba(color, a * 0.3));
        g.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = g;
        ctx.fillRect(e.x - r * 4, e.y - r * 4, r * 8, r * 8);
        ctx.fillStyle = rgba("#ffffff", a * 0.6);
        ctx.beginPath();
        ctx.arc(e.x, e.y, r * 0.5, 0, Math.PI * 2);
        ctx.fill();
        e.spark = false;
      }
      if (Math.random() < 0.015) {
        const bx = Math.random() * W;
        for (let i = 0; i < 5; i++) {
          const e = makeEmber();
          e.x = bx + (Math.random() - 0.5) * 40;
          e.y = H - 10;
          e.vy *= 1.5;
          embers.push(e);
        }
      }
      ctx.globalCompositeOperation = "source-over";
    }
    draw();
  }
}
