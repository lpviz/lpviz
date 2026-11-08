import type { AppActions } from "@/app/appActions";
import { setCurrentMouse } from "@/features/core/currentMouse";
import { getState, on, type State } from "@/features/core/store";
import type { EditorTools } from "@/features/polytope-editor/editorTools";
import type { SolverMode, SolverSettings } from "@/features/solver/solverSettings";
import { zoomFitTarget } from "@/features/viewport/bounds";
import type { ViewportApi } from "@/features/viewport/runtime";
import { get3DControlsConfig, getViewportRenderSnapshot } from "@/features/viewport/runtime/channels";
import type { BoundingBox } from "@lpviz/math/bounds";
import type { Vec } from "@lpviz/math/types";
import type { Cursor } from "./cursor";
import type { PartsController, RecordPart } from "./parts";

/**
 * Where the cursor goes: a world point `[x, y]`, a CSS selector or element (its center), or a raw
 * client point `{ client: [x, y] }`.
 */
export type Target = Vec | string | HTMLElement | { client: [number, number] };

export type DirectorOptions = {
  /** multiplies every cursor glide and pause; 2 is half as fast */
  pace: number;
  /** how long each solver's path takes to draw itself on */
  replayMs: number;
  captions: boolean;
  /** each take starts this many times closer in than the default view, on the origin */
  zoom: number;
};

export type DirectorDeps = {
  actions: AppActions;
  tools: EditorTools;
  viewportApi: ViewportApi;
  cursor: Cursor;
  caption: (text: string | null) => void;
  parts: PartsController;
  options: DirectorOptions;
  signal: AbortSignal;
};

export type MoveOptions = { durationMs?: number };

// The scripting surface: every call animates the on-screen cursor and acts through the same code
// paths a person's mouse does (the editor tools for the canvas, a real click for a button), and
// resolves when its effect has played out. Each call throws once the run is aborted.
export function createDirector({ actions, tools, viewportApi, cursor, caption, parts, options, signal }: DirectorDeps) {
  const canvas = viewportApi.getCanvasElement();

  const check = () => {
    if (signal.aborted) throw signal.reason;
  };

  const wait = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      check();
      const id = window.setTimeout(resolve, ms * options.pace);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(id);
          reject(signal.reason);
        },
        { once: true },
      );
    });

  /** Resolve the next time `pick(state)` holds after a patch to `keys` (or now, when it already holds). */
  const until = <K extends keyof State>(keys: readonly K[], pick: (state: Readonly<State>) => boolean, timeoutMs = 8000) =>
    new Promise<void>((resolve) => {
      if (pick(getState())) return resolve();
      const local = new AbortController();
      const done = () => {
        local.abort();
        clearTimeout(timer);
        resolve();
      };
      const timer = window.setTimeout(done, timeoutMs);
      signal.addEventListener("abort", done, { once: true });
      on(keys, () => pick(getState()) && done(), local.signal);
    });

  const worldToClient = (point: Vec): [number, number] => {
    const rect = viewportApi.getCanvasRect();
    const p = viewportApi.toCanvasCoords(point);
    return [rect.left + p.x, rect.top + p.y];
  };

  const resolveElement = (target: string | HTMLElement): HTMLElement => {
    const element = typeof target === "string" ? document.querySelector<HTMLElement>(target) : target;
    if (!element) throw new Error(`record: no element matches ${String(target)}`);
    return element;
  };

  const toClient = (target: Target): [number, number] => {
    if (typeof target === "string" || target instanceof HTMLElement) {
      const r = resolveElement(target).getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    }
    if ("client" in target) return target.client;
    return worldToClient(target);
  };

  const overCanvas = (x: number, y: number) => document.elementFromPoint(x, y) === canvas;

  // over the canvas the cursor hovers like a mouse: the sketch edge or the objective preview follows it
  const hover = (x: number, y: number) => {
    if (overCanvas(x, y)) tools.handleDragMove(x, y);
  };

  const glideDuration = (x: number, y: number) => {
    const dist = Math.hypot(x - cursor.x, y - cursor.y);
    return Math.min(1100, 320 + dist * 0.75);
  };

  const move = async (target: Target, opts: MoveOptions = {}) => {
    check();
    const [x, y] = toClient(target);
    await cursor.glide(x, y, { durationMs: (opts.durationMs ?? glideDuration(x, y)) * options.pace, signal, onFrame: hover });
  };

  const tap = async () => {
    cursor.press();
    cursor.ripple();
    await wait(110);
    cursor.release();
  };

  /** Move to the target, then click it: a canvas click goes to the editor, anything else gets a real click(). */
  const click = async (target?: Target, opts: MoveOptions = {}) => {
    if (target !== undefined) await move(target, opts);
    check();
    const element = target !== undefined && (typeof target === "string" || target instanceof HTMLElement) ? resolveElement(target) : null;
    await tap();
    if (element) element.click();
    else if (overCanvas(cursor.x, cursor.y)) tools.handleClick(cursor.x, cursor.y);
    await wait(90);
  };

  const doubleClick = async (target?: Target) => {
    if (target !== undefined) await move(target);
    await tap();
    await wait(60);
    await tap();
    tools.handleDoubleClickAt(cursor.x, cursor.y);
    await wait(90);
  };

  /**
   * Press on `from` (a vertex, an edge, the objective's tip, the start marker), drag, release. The
   * drag is one smooth eased motion: along `path(t)` (t from 0 to 1, in world coordinates) when it
   * is a function, otherwise along a curve through the given point(s).
   */
  const drag = async (from: Target, path: Target | Target[] | ((t: number) => Vec), opts: { durationMs?: number } = {}) => {
    await move(from);
    check();
    cursor.press();
    await wait(80);
    if (!tools.handleDragStart(cursor.x, cursor.y)) {
      cursor.release();
      throw new Error("record: drag started on nothing draggable");
    }
    const start: [number, number] = [cursor.x, cursor.y];
    let pointAt: (t: number) => [number, number];
    let length: number;
    if (typeof path === "function") {
      pointAt = (t) => worldToClient(path(t));
      length = 0;
      let prev = pointAt(0);
      for (let i = 1; i <= 32; i++) {
        const next = pointAt(i / 32);
        length += Math.hypot(next[0] - prev[0], next[1] - prev[1]);
        prev = next;
      }
    } else {
      const targets = Array.isArray(path) && (path.length === 0 || typeof path[0] !== "number") ? (path as Target[]) : [path as Target];
      ({ pointAt, length } = smoothCurve([start, ...targets.map(toClient)]));
    }
    try {
      await cursor.follow(pointAt, { durationMs: (opts.durationMs ?? Math.min(4000, 400 + length * 1.6)) * options.pace, signal, onFrame: (fx, fy) => tools.handleDragMove(fx, fy) });
    } finally {
      tools.handleDragEnd();
      cursor.release();
    }
    await wait(120);
  };

  /** A point at a fraction of the visible canvas, `[0, 0]` its top-left and `[1, 1]` its bottom-right. */
  const at = (u: number, v: number): Vec => {
    const rect = viewportApi.getCanvasRect();
    return viewportApi.toLogicalCoords(rect.width * u, rect.height * v);
  };

  /** A point on the polar arc around the origin, for sweeping the objective. */
  const polar = (radius: number, angleRad: number): Vec => [radius * Math.cos(angleRad), radius * Math.sin(angleRad)];

  /** Click out a region vertex by vertex, then click the first vertex again to close it. */
  const draw = async (vertices: Vec[], { close = true, pauseMs = 140 }: { close?: boolean; pauseMs?: number } = {}) => {
    for (const vertex of vertices) {
      await click(vertex);
      await wait(pauseMs);
    }
    if (close && vertices[0]) await click(vertices[0]);
  };

  /** Hover toward the objective (its arrow previews along the way), then click to place it. */
  const objective = async (tip: Vec) => {
    await click(tip);
  };

  /** Wait for the solve in flight, if any, to land in the store. */
  const waitForSolve = (previous: Pick<State, "originalIteratePath" | "result">) =>
    until(["originalIteratePath", "result"], (s) => s.originalIteratePath !== previous.originalIteratePath || s.result !== previous.result, 6000);

  /** Draw the current path on from its first iterate, and wait for it to finish. */
  const animate = async () => {
    check();
    if (getState().originalIteratePath.count === 0) return;
    if (!getState().replayActive) actions.toggleReplay();
    await until(["replayActive"], (s) => !s.replayActive, options.replayMs * 2 + 2000);
  };

  const isShown = (element: HTMLElement | null) => Boolean(element && element.getClientRects().length > 0);

  /** Click the solver's button and watch its path draw on; with the buttons out of the shot, switch without the cursor. */
  const solver = async (mode: SolverMode, { animate: replay = true }: { animate?: boolean } = {}) => {
    const { originalIteratePath, result } = getState();
    const before = { originalIteratePath, result };
    const button = document.querySelector<HTMLElement>(`#${mode}Button`);
    if (isShown(button)) await click(button!);
    else {
      check();
      actions.setActiveSolverMode(mode);
    }
    await waitForSolve(before);
    if (replay) await animate();
  };

  /** Change a solver setting (no cursor) and re-solve. */
  const setting = <K extends keyof SolverSettings>(key: K, value: SolverSettings[K]) => {
    actions.updateSolverSetting(key, value);
    actions.recomputeIfModeActive(getState().solverMode);
  };

  const toggle3D = async () => {
    actions.toggle3D();
    await wait(50);
    await until(["isTransitioning3D"], (s) => !s.isTransitioning3D, 4000);
  };

  /**
   * Orbit the 3D camera `radians` about the vertical through its target over `durationMs`, at an
   * even speed (or eased in and out), optionally tilting by `tilt` radians along the way and back.
   * Runs alongside other steps when not awaited.
   */
  const orbit = (radians: number, { durationMs, ease = false, tilt = 0 }: { durationMs: number; ease?: boolean; tilt?: number }) =>
    new Promise<void>((resolve, reject) => {
      const { perspective, target: snapshotTarget } = getViewportRenderSnapshot();
      const target = { ...snapshotTarget };
      const ox = perspective.position.x - target.x;
      const oy = perspective.position.y - target.y;
      const oz = perspective.position.z - target.z;
      const horizontal = Math.hypot(ox, oy);
      const distance = Math.hypot(horizontal, oz);
      const yaw0 = Math.atan2(oy, ox);
      const elevation0 = Math.atan2(oz, horizontal);
      const start = performance.now();
      const step = () => {
        if (signal.aborted) return reject(signal.reason);
        const t = durationMs <= 0 ? 1 : Math.min(1, (performance.now() - start) / durationMs);
        const e = ease ? -(Math.cos(Math.PI * t) - 1) / 2 : t;
        const yaw = yaw0 + radians * e;
        const elevation = elevation0 + tilt * Math.sin(Math.PI * t);
        const position = {
          x: target.x + distance * Math.cos(elevation) * Math.cos(yaw),
          y: target.y + distance * Math.cos(elevation) * Math.sin(yaw),
          z: target.z + distance * Math.sin(elevation),
        };
        get3DControlsConfig().onChange?.({ position, up: { x: 0, y: 0, z: 1 }, target });
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });

  /** Spin the objective for `ms`, optionally leaving a trace of every path it passes through. */
  const rotate = async (ms: number, { trace = false }: { trace?: boolean } = {}) => {
    actions.setTraceEnabled(trace);
    actions.startRotation();
    try {
      await wait(ms);
    } finally {
      actions.stopMotion();
    }
  };

  /**
   * Rotate the objective through `turns` full turns, measured by its angle (so takes of different
   * solvers stay in step however long a frame's solve takes), with the trace on or off. Keeps
   * rotating afterwards unless `stop`, so spins chain into one continuous motion.
   */
  const spin = async (turns: number, { trace = false, stop = true }: { trace?: boolean; stop?: boolean } = {}) => {
    check();
    if (getState().traceEnabled !== trace) actions.setTraceEnabled(trace);
    if (!getState().rotateObjectiveMode) actions.startRotation();
    const angleOf = () => {
      const v = getState().objectiveVector;
      return v ? Math.atan2(v[1], v[0]) : 0;
    };
    let last = angleOf();
    let travelled = 0;
    try {
      await until(
        ["objectiveVector"],
        () => {
          const now = angleOf();
          let delta = now - last;
          if (delta > Math.PI) delta -= 2 * Math.PI;
          if (delta < -Math.PI) delta += 2 * Math.PI;
          travelled += Math.abs(delta);
          last = now;
          return travelled >= turns * 2 * Math.PI - 1e-9;
        },
        600_000,
      );
      check();
    } finally {
      if (stop || signal.aborted) actions.stopMotion();
    }
  };

  const say = async (text: string | null, holdMs = 0) => {
    if (options.captions) caption(text);
    if (holdMs) await wait(holdMs);
  };

  /** Put a finished problem on the canvas at once, no drawing (and zoom to fit it). */
  const load = async (vertices: Vec[], objectiveVector: Vec) => {
    check();
    const n = vertices.length;
    const interiorPoint: Vec = [vertices.reduce((s, v) => s + v[0], 0) / n, vertices.reduce((s, v) => s + v[1], 0) / n];
    actions.loadGalleryProblem({ id: "record", name: "record", vertices, interiorPoint, objectiveVector });
    await wait(400);
  };

  /** Take parts of the screen out of the shot (see parts.ts), or put them back. */
  const hide = async (...names: RecordPart[]) => {
    parts.hide(...names);
    await wait(50);
  };
  const show = async (...names: RecordPart[]) => {
    parts.show(...names);
    await wait(50);
  };

  /**
   * Move the camera, smoothly, to frame a region: the drawing and its path (`"drawing"`), a set of
   * world points, or a world box, with `margin` (a fraction of its size) around it. In 3D the move is a cut. The view's fit pads what it frames, so
   * the start is calibrated: the box whose fit reproduces the view on screen right now.
   */
  const frame = async (target: "drawing" | Vec[] | BoundingBox, { durationMs = 1100, margin = 0.1 }: { durationMs?: number; margin?: number } = {}) => {
    check();
    const state = getState();
    let to: BoundingBox | null;
    if (target === "drawing") to = zoomFitTarget(state)?.bounds ?? null;
    else if (Array.isArray(target)) {
      const xs = target.map((p) => p[0]);
      const ys = target.map((p) => p[1]);
      to = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    } else to = target;
    if (!to) return;
    if (state.is3DMode || state.isTransitioning3D) {
      viewportApi.zoomToFit(to);
      return;
    }
    const box = (b: BoundingBox) => ({ cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, hx: (b.maxX - b.minX) / 2, hy: (b.maxY - b.minY) / 2 });
    // what is on screen beside the sidebar, corner to corner (getVisibleBounds pads it, and the
    // fit frames into the area the sidebar leaves)
    const rect = viewportApi.getCanvasRect();
    const sidebarPx = Number.parseFloat(getComputedStyle(document.getElementById("root") ?? document.documentElement).getPropertyValue("--sidebar-width")) || 0;
    const left = Math.min(0.9, sidebarPx / rect.width);
    const onScreen = (): BoundingBox => {
      const [x0, y0] = at(left, 0);
      const [x1, y1] = at(1, 1);
      return { minX: Math.min(x0, x1), maxX: Math.max(x0, x1), minY: Math.min(y0, y1), maxY: Math.max(y0, y1) };
    };
    const shown = onScreen();
    const now = box(shown);
    viewportApi.zoomToFit(shown);
    const fitted = box(onScreen());
    const k = fitted.hx / now.hx;
    const from = { cx: now.cx - (fitted.cx - now.cx), cy: now.cy - (fitted.cy - now.cy), hx: now.hx / k, hy: now.hy / k };
    const framed = box(to);
    // breathing room around what is framed, as a fraction of its size
    const end = { ...framed, hx: framed.hx * (1 + margin), hy: framed.hy * (1 + margin) };
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
    // the size eases geometrically, so a big zoom feels as even as a small one
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const glerp = (a: number, b: number, t: number) => a * (b / a) ** t;
    const apply = (t: number) => {
      const cx = lerp(from.cx, end.cx, t);
      const cy = lerp(from.cy, end.cy, t);
      const hx = glerp(from.hx, Math.max(end.hx, 1e-6), t);
      const hy = glerp(from.hy, Math.max(end.hy, 1e-6), t);
      viewportApi.zoomToFit({ minX: cx - hx, maxX: cx + hx, minY: cy - hy, maxY: cy + hy });
    };
    apply(0);
    const total = durationMs * options.pace;
    if (total <= 0) {
      apply(1);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const start = performance.now();
      const step = () => {
        const time = performance.now();
        if (signal.aborted) return reject(signal.reason);
        const t = Math.min(1, (time - start) / total);
        apply(ease(t));
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  };

  const showCursor = () => cursor.show();
  const hideCursor = () => {
    cursor.hide();
    setCurrentMouse(null);
  };

  return {
    wait,
    until,
    move,
    click,
    doubleClick,
    drag,
    at,
    polar,
    draw,
    objective,
    load,
    hide,
    show,
    frame,
    solver,
    animate,
    setting,
    toggle3D,
    rotate,
    spin,
    orbit,
    /** tell a frame-by-frame capture the take starts here (frames before it are setup) */
    mark: () => {
      (window as unknown as { __recordMark?: boolean }).__recordMark = true;
    },
    caption: say,
    showCursor,
    hideCursor,
    zoomToFit: () => actions.zoomToFit(),
    toClient,
    state: getState,
    actions,
  };
}

export type Director = ReturnType<typeof createDirector>;

/**
 * A Catmull-Rom curve through the points, parameterized by distance travelled so the speed is even
 * along it (the caller eases the ends): the point at fraction t of the way, and the total length.
 */
function smoothCurve(points: [number, number][]): { pointAt: (t: number) => [number, number]; length: number } {
  if (points.length < 2) {
    const only = points[0] ?? [0, 0];
    return { pointAt: () => only, length: 0 };
  }
  const p = (i: number) => points[Math.max(0, Math.min(points.length - 1, i))]!;
  const segment = (i: number, u: number): [number, number] => {
    const [a, b, c, d] = [p(i - 1), p(i), p(i + 1), p(i + 2)];
    const u2 = u * u;
    const u3 = u2 * u;
    const f = (k: 0 | 1) => 0.5 * (2 * b[k] + (-a[k] + c[k]) * u + (2 * a[k] - 5 * b[k] + 4 * c[k] - d[k]) * u2 + (-a[k] + 3 * b[k] - 3 * c[k] + d[k]) * u3);
    return [f(0), f(1)];
  };
  // a dense sampling, with the distance travelled at each sample
  const samples: [number, number][] = [];
  const along: number[] = [];
  const perSegment = 24;
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    for (let j = i === 0 ? 0 : 1; j <= perSegment; j++) {
      const q = segment(i, j / perSegment);
      const last = samples[samples.length - 1];
      if (last) total += Math.hypot(q[0] - last[0], q[1] - last[1]);
      samples.push(q);
      along.push(total);
    }
  }
  const pointAt = (t: number): [number, number] => {
    if (total === 0) return samples[0]!;
    const target = t * total;
    let lo = 0;
    let hi = along.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (along[mid]! < target) lo = mid;
      else hi = mid;
    }
    const span = along[hi]! - along[lo]! || 1;
    const f = Math.min(1, Math.max(0, (target - along[lo]!) / span));
    const [a, b] = [samples[lo]!, samples[hi]!];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  };
  return { pointAt, length: total };
}
