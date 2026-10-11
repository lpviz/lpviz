import { getState } from "@/features/core/store";
import { canPan2D } from "@/features/problem/selectors";
import { get2DControlsConfig } from "@/features/viewport/runtime/channels";
import type { PointXY } from "@lpviz/math/types";
import { buildViewport2DSnapshot, buildViewport2DStateFromTarget, zoomViewport2DStateAtCanvasPoint } from "@lpviz/viewport/projection2d";
import type { ViewportRect } from "@lpviz/viewport/snapshot";
import { attachPointerGestures } from "./pointerGestures";

const WHEEL_ZOOM_FACTOR = 1.05;

// The 2D view's pan (any single pointer) and zoom (wheel, pinch). They read the 2D controls
// config, act only while it owns the view (the pan also only while the drawing lets it, see
// canPan2D), and report every move through it.
export function attachPanZoom2D(canvas: HTMLCanvasElement, signal: AbortSignal): void {
  // the view at the start of a pan, which each move offsets from
  let activePan: { startClientX: number; startClientY: number; targetX: number; targetY: number; scaleFactor: number; gridSpacing: number } | null = null;
  let activePinch: { startDistance: number; startScaleFactor: number } | null = null;

  const canZoom = () => {
    const config = get2DControlsConfig();
    return config.enabled && !config.blocked;
  };
  const canPan = () => canZoom() && canPan2D(getState());

  const startPan = (clientX: number, clientY: number) => {
    if (!canPan()) return false;
    const config = get2DControlsConfig();
    const snapshot = buildViewport2DSnapshot(config, canvas.getBoundingClientRect());
    activePan = { startClientX: clientX, startClientY: clientY, targetX: snapshot.target.x, targetY: snapshot.target.y, scaleFactor: config.state.scaleFactor, gridSpacing: config.state.gridSpacing };
    return true;
  };
  const updatePan = (clientX: number, clientY: number) => {
    // a pan in progress ends the moment the controls lose the view or the drawing stops panning
    if (activePan && !canPan()) activePan = null;
    if (!activePan) return;
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

  attachPointerGestures(
    canvas,
    {
      dragStart: (event) => event.button === 0 && startPan(event.clientX, event.clientY),
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
