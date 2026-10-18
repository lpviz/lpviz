import { getState } from "@/features/core/store";
import { canPan2D, computeDrawingPhase } from "@/features/problem/selectors";
import { get2DControlsConfig } from "@/features/viewport/runtime/channels";
import type { PointXY } from "@lpviz/math/types";
import { buildViewport2DSnapshot, buildViewport2DStateFromTarget, zoomViewport2DStateAtCanvasPoint } from "@lpviz/viewport/projection2d";
import type { ViewportRect } from "@lpviz/viewport/snapshot";
import { attachPointerGestures } from "./pointerGestures";

const WHEEL_ZOOM_FACTOR = 1.05;
// While a click places something (a vertex, the objective), a mouse or pen press is told apart
// from a pan by how the pointer was moving as it went down. A press from rest is a grab: the pan
// starts once it drifts past PAN_SLOP_PX (the click's own allowance, see canvasGestures). A press
// from a pointer sweeping faster than SWEEP_PX_PER_MS, as when drawing fast, is a click whatever
// it drifts, unless it is held past CLICK_MS like a grab. Either way the pan starts from where the
// pointer is when it does, so the view does not jump to make up the drift. Once the drawing is
// finished a click places nothing and the pan starts at once, as a finger's always does (a tap is
// told apart by its slop).
const PAN_SLOP_PX = 5;
const SWEEP_PX_PER_MS = 0.25;
const CLICK_MS = 250;
// the pointer's speed is read over its moves in this window before the press
const SPEED_WINDOW_MS = 80;

// The 2D view's pan (any single pointer) and zoom (wheel, pinch). They read the 2D controls
// config, act only while it owns the view (the pan also only while the drawing lets it, see
// canPan2D), and report every move through it.
export function attachPanZoom2D(canvas: HTMLCanvasElement, signal: AbortSignal): void {
  // the view at the start of a pan, which each move offsets from
  let activePan: {
    startClientX: number;
    startClientY: number;
    startTime: number;
    /** the press came from a sweeping pointer: a click unless held */
    sweeping: boolean;
    engaged: boolean;
    targetX: number;
    targetY: number;
    scaleFactor: number;
    gridSpacing: number;
  } | null = null;
  let activePinch: { startDistance: number; startScaleFactor: number } | null = null;

  const canZoom = () => {
    const config = get2DControlsConfig();
    return config.enabled && !config.blocked;
  };
  const canPan = () => canZoom() && canPan2D(getState());

  // the pointer's recent hover moves, newest last, kept for SPEED_WINDOW_MS
  let recentMoves: { x: number; y: number; t: number }[] = [];
  const trackMove = ({ clientX, clientY, timeStamp }: PointerEvent) => {
    recentMoves = recentMoves.filter((m) => timeStamp - m.t <= SPEED_WINDOW_MS);
    recentMoves.push({ x: clientX, y: clientY, t: timeStamp });
  };
  const speedAt = ({ clientX, clientY, timeStamp }: PointerEvent) => {
    const oldest = recentMoves.find((m) => timeStamp - m.t <= SPEED_WINDOW_MS);
    if (!oldest || timeStamp - oldest.t <= 0) return 0;
    return Math.hypot(clientX - oldest.x, clientY - oldest.y) / (timeStamp - oldest.t);
  };

  const startPan = (event: PointerEvent) => {
    if (!canPan()) return false;
    const { clientX, clientY, pointerType, timeStamp } = event;
    const config = get2DControlsConfig();
    const snapshot = buildViewport2DSnapshot(config, canvas.getBoundingClientRect());
    activePan = {
      startClientX: clientX,
      startClientY: clientY,
      startTime: timeStamp,
      sweeping: speedAt(event) > SWEEP_PX_PER_MS,
      engaged: pointerType === "touch" || computeDrawingPhase(getState()) === "ready_for_solvers",
      targetX: snapshot.target.x,
      targetY: snapshot.target.y,
      scaleFactor: config.state.scaleFactor,
      gridSpacing: config.state.gridSpacing,
    };
    return true;
  };
  const isStillClicking = (pan: NonNullable<typeof activePan>, clientX: number, clientY: number) =>
    Math.hypot(clientX - pan.startClientX, clientY - pan.startClientY) <= PAN_SLOP_PX || (pan.sweeping && performance.now() - pan.startTime <= CLICK_MS);
  const updatePan = (clientX: number, clientY: number) => {
    // a pan in progress ends the moment the controls lose the view or the drawing stops panning
    if (activePan && !canPan()) activePan = null;
    if (!activePan) return;
    if (!activePan.engaged) {
      if (isStillClicking(activePan, clientX, clientY)) return;
      activePan = { ...activePan, startClientX: clientX, startClientY: clientY, engaged: true };
    }
    const config = get2DControlsConfig();
    const unitsPerPixel = 1 / (activePan.gridSpacing * activePan.scaleFactor);
    const target = { x: activePan.targetX - (clientX - activePan.startClientX) * unitsPerPixel, y: activePan.targetY + (clientY - activePan.startClientY) * unitsPerPixel };
    config.onStateChange?.(buildViewport2DStateFromTarget(target, activePan.scaleFactor, activePan.gridSpacing, config.sidebarWidth));
    config.onNavigationFrame?.();
  };
  const stopPan = () => {
    if (!activePan) return false;
    activePan = null;
    return true;
  };
  const zoomAt = (point: PointXY, rect: ViewportRect, scaleFactor: number) => {
    if (!canZoom()) return false;
    const config = get2DControlsConfig();
    config.onStateChange?.(zoomViewport2DStateAtCanvasPoint(config, rect, point, scaleFactor));
    config.onNavigationFrame?.();
    return true;
  };

  canvas.addEventListener("pointermove", trackMove, { signal });
  attachPointerGestures(
    canvas,
    {
      dragStart: (event) => event.button === 0 && startPan(event),
      dragMove: updatePan,
      dragEnd: stopPan,
      // a second finger turns the gesture into a pinch; the pan it interrupts ends
      pinchStart: ({ distance }) => {
        if (distance <= 0 || !canZoom()) return false;
        activePinch = { startDistance: distance, startScaleFactor: get2DControlsConfig().state.scaleFactor };
        stopPan();
        return true;
      },
      pinchMove: ({ center, distance }) => {
        if (!activePinch || distance <= 0) return;
        const rect = canvas.getBoundingClientRect();
        zoomAt({ x: center.x - rect.left, y: center.y - rect.top }, rect, activePinch.startScaleFactor * (distance / activePinch.startDistance));
      },
      pinchEnd: () => {
        activePinch = null;
      },
      wheel: (event, dominantDelta) => {
        const rect = canvas.getBoundingClientRect();
        const { state } = get2DControlsConfig();
        return zoomAt({ x: event.clientX - rect.left, y: event.clientY - rect.top }, rect, state.scaleFactor * (dominantDelta < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR));
      },
    },
    signal,
  );
}
