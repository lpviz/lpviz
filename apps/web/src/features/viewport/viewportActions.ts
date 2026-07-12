import { getState, setState } from "@/features/core/store";
import { collectZoomFitBounds } from "@/features/viewport/bounds";
import type { ViewportApi } from "@/features/viewport/runtime";

export type ViewportActions = ReturnType<typeof createViewportActions>;

export function createViewportActions(getCanvasManager: () => ViewportApi | null, initialSidebarWidth: number) {
  let currentSidebarWidth = initialSidebarWidth;
  const syncSidebarViewport = () => {
    const cm = getCanvasManager();
    if (!cm) return;
    cm.setSidebarWidth(currentSidebarWidth);
    cm.updateDimensions();
    cm.draw();
  };
  const resetView = () => {
    const cm = getCanvasManager();
    if (!cm) return;
    cm.resetView();
    // /3d: recentering on the world origin can lose an off-origin solid —
    // reset the orientation, then frame the model
    const state = getState();
    if (state.problemMode === "3d" && state.polytope3) {
      window.requestAnimationFrame(() => zoomToFit());
    }
  };
  const zoomToFit = () => {
    const cm = getCanvasManager();
    if (!cm) return;
    const state = getState();
    const isOpenUnbounded = state.completionMode === "open" && state.polytope?.kind === "unbounded";
    const zoomFit = collectZoomFitBounds(state);
    if (!zoomFit && !isOpenUnbounded) return;
    cm.zoomToFit(isOpenUnbounded ? cm.getUnboundedClipBounds() : zoomFit!.bounds, 50, zoomFit?.zBounds);
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
    toggle3D,
    setZScale,
    setSidebarWidth,
    syncViewportLayout,
    getCurrentSidebarWidth: () => currentSidebarWidth,
    syncSidebarViewport,
  };
}
