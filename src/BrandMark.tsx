import "./brand.css";

/** Owner-approved Scanline 1B exports; never recolour or redraw these assets. */
export function BrandMark({ size = 24 }: { size?: number }) {
  const suffix = [16, 24, 32, 48].includes(size) ? `-${size}` : "";
  return (
    <span
      className="coherence-mark"
      role="img"
      aria-label="Coherence — Scanline 1B logo"
      style={{ width: size, height: size }}
    >
      <img
        className="coherence-mark-dark"
        src={`/brand/scanline-dark${suffix}.svg`}
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
      />
      <img
        className="coherence-mark-light"
        src={`/brand/scanline-light${suffix}.svg`}
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
      />
    </span>
  );
}
