import { getState, setState } from "@/features/core/store";
import { collectZoomFitBounds } from "@/features/viewport/bounds";
import type { ViewportApi } from "@/features/viewport/runtime";

export type ViewportActions = ReturnType<typeof createViewportActions>;

export function createViewportActions(
  getCanvasManager: () => ViewportApi | null,
  initialSidebarWidth: number,
) {
  let currentSidebarWidth = initialSidebarWidth;
  // Pixels along the top of the canvas covered by the problem gallery while
  // it is open. Zoom-to-fit keeps the region below it, so a preset picked from
  // the open strip does not land its top vertices under the strip.
  let topInset = 0;
  const setTopInset = (px: number) => {
    topInset = Math.max(0, px);
  };
  const syncSidebarViewport = () => {
    const cm = getCanvasManager();
    if (!cm) return;
    cm.setSidebarWidth(currentSidebarWidth);
    cm.updateDimensions();
    cm.draw();
  };
  const resetView = () => getCanvasManager()?.resetView();
  const zoomToFit = () => {
    const cm = getCanvasManager();
    if (!cm) return;
    const state = getState();
    const isOpenUnbounded =
      state.completionMode === "open" && state.polytope?.kind === "unbounded";
    const zoomFit = collectZoomFitBounds(state);
    if (!zoomFit && !isOpenUnbounded) return;
    cm.zoomToFit(
      isOpenUnbounded ? cm.getUnboundedClipBounds() : zoomFit!.bounds,
      50,
      zoomFit?.zBounds,
      topInset,
    );
    cm.setSidebarWidth(currentSidebarWidth);
  };
  const toggle3D = () => {
    const cm = getCanvasManager();
    if (!cm) return;
    const s = getState();
    if (s.isTransitioning3D) return;
    cm.start3DTransition(!s.is3DMode);
  };
  const setZScale = (value: number) => {
    const cm = getCanvasManager();
    if (!cm) return;
    setState({ zScale: value }); // zScale derives polytope+objective+trace+iterate
    const { is3DMode, isTransitioning3D } = getState();
    if (is3DMode || isTransitioning3D) cm.draw();
  };
  const setSidebarWidth = (width: number) => {
    currentSidebarWidth = width;
    const cm = getCanvasManager();
    if (!cm) return;
    cm.setSidebarWidth(width);
    cm.draw();
  };
  const syncViewportLayout = (sidebarWidth: number) => {
    currentSidebarWidth = sidebarWidth;
    syncSidebarViewport();
  };
  return {
    resetView,
    zoomToFit,
    setTopInset,
    toggle3D,
    setZScale,
    setSidebarWidth,
    syncViewportLayout,
    getCurrentSidebarWidth: () => currentSidebarWidth,
    syncSidebarViewport,
  };
}
