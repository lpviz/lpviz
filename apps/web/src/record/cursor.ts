// The on-screen cursor the record mode draws in place of the real one: an arrow that glides along
// a gentle arc between points, dips on a press and leaves a ripple where it clicked. Positions are
// client coordinates of the arrow's tip.

const ARROW_SVG =
  '<svg width="26" height="30" viewBox="0 0 26 30" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<path d="M2 2 L2 24 L8 18.5 L12.2 27.6 L16 25.9 L11.9 17 L20 17 Z" fill="#111" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/>' +
  "</svg>";

export type Cursor = {
  readonly x: number;
  readonly y: number;
  show: () => void;
  hide: () => void;
  /** jump without animating */
  place: (x: number, y: number) => void;
  /** glide to (x, y); `onFrame` sees every intermediate point */
  glide: (x: number, y: number, opts: { durationMs: number; signal: AbortSignal; onFrame?: (x: number, y: number) => void }) => Promise<void>;
  /** travel along `pointAt(t)`, t from 0 to 1, as one eased motion */
  follow: (pointAt: (t: number) => [number, number], opts: { durationMs: number; signal: AbortSignal; onFrame?: (x: number, y: number) => void }) => Promise<void>;
  press: () => void;
  release: () => void;
  ripple: () => void;
  destroy: () => void;
};

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
// gentler at the ends than the cubic, for a long drag: it never crawls, and never rushes the middle
const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;

export function createCursor(): Cursor {
  const node = document.createElement("div");
  node.className = "record-cursor";
  node.innerHTML = ARROW_SVG;
  document.body.append(node);
  let x = window.innerWidth * 0.62;
  let y = window.innerHeight * 0.55;

  const render = () => {
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
  };
  render();
  // The plot redraws on the frame after a hover or drag moves it; the arrow is drawn on that same
  // frame, so the sketch edge or the dragged point never trails behind the arrow's tip.
  const renderWithCanvas = () => requestAnimationFrame(render);

  const glide: Cursor["glide"] = (tx, ty, { durationMs, signal, onFrame }) =>
    new Promise<void>((resolve, reject) => {
      const sx = x;
      const sy = y;
      const dx = tx - sx;
      const dy = ty - sy;
      const dist = Math.hypot(dx, dy);
      // a hand never moves in a ruler-straight line: bow the path a little to one side
      const bow = Math.min(60, dist * 0.12);
      const cx = sx + dx / 2 + (dist > 0 ? (-dy / dist) * bow : 0);
      const cy = sy + dy / 2 + (dist > 0 ? (dx / dist) * bow : 0);
      const start = performance.now();
      const step = () => {
        const now = performance.now();
        if (signal.aborted) return reject(signal.reason);
        const t = durationMs <= 0 ? 1 : Math.min(1, (now - start) / durationMs);
        const e = easeInOut(t);
        const u = 1 - e;
        x = u * u * sx + 2 * u * e * cx + e * e * tx;
        y = u * u * sy + 2 * u * e * cy + e * e * ty;
        onFrame?.(x, y);
        renderWithCanvas();
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });

  const follow: Cursor["follow"] = (pointAt, { durationMs, signal, onFrame }) =>
    new Promise<void>((resolve, reject) => {
      const start = performance.now();
      const step = () => {
        const now = performance.now();
        if (signal.aborted) return reject(signal.reason);
        const t = durationMs <= 0 ? 1 : Math.min(1, (now - start) / durationMs);
        [x, y] = pointAt(easeInOutSine(t));
        onFrame?.(x, y);
        renderWithCanvas();
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });

  return {
    get x() {
      return x;
    },
    get y() {
      return y;
    },
    show: () => node.classList.add("record-cursor--visible"),
    hide: () => node.classList.remove("record-cursor--visible"),
    place: (nx, ny) => {
      x = nx;
      y = ny;
      render();
    },
    glide,
    follow,
    press: () => node.classList.add("record-cursor--pressed"),
    release: () => node.classList.remove("record-cursor--pressed"),
    ripple: () => {
      const ring = document.createElement("div");
      ring.className = "record-ripple";
      ring.style.left = `${x}px`;
      ring.style.top = `${y}px`;
      document.body.append(ring);
      ring.addEventListener("animationend", () => ring.remove(), { once: true });
    },
    destroy: () => node.remove(),
  };
}
