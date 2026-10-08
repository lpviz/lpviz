import { DEFAULT_VIEW_ANGLE, getState, setState } from "@/features/core/store";
import type { BoundingBox } from "@lpviz/math/bounds";
import { fitViewport2DToBounds } from "@lpviz/viewport/projection2d";
import type { ViewportZBounds } from "@lpviz/viewport/snapshot";
import { buildResetViewport3DView, fitViewport3DToBounds } from "@lpviz/viewport/view3d";
import type { ViewportRuntimeContext } from "./context";
import { getViewport2DControlsConfig, setViewport2DControlsState } from "./controls2d";
import type { ControlsSync } from "./controlsSync";

// The ViewportApi methods that move the view as a whole: zoomToFit and resetView.
export function createViewFitApi({
  wants2DControls,
  getManagerSnapshot,
  getViewportRect,
  getSidebarWidth,
  applyPerspectivePose,
}: Pick<ViewportRuntimeContext, "wants2DControls" | "getManagerSnapshot" | "getViewportRect" | "getSidebarWidth"> & Pick<ControlsSync, "applyPerspectivePose">) {
  return {
    zoomToFit: (bounds: BoundingBox, padding?: number, zBounds?: ViewportZBounds, topInset?: number) => {
      if (wants2DControls()) {
        const { state, sidebarWidth } = getViewport2DControlsConfig();
        setViewport2DControlsState(fitViewport2DToBounds(state, sidebarWidth, getViewportRect(), getManagerSnapshot(), bounds, padding, topInset));
        return;
      }

      if (!getState().isTransitioning3D) {
        const state = getState();
        const nextView = fitViewport3DToBounds(
          getManagerSnapshot(),
          getViewportRect(),
          getSidebarWidth(),
          bounds,
          padding,
          zBounds
            ? {
                minZ: (zBounds.minZ * state.zScale) / 100,
                maxZ: (zBounds.maxZ * state.zScale) / 100,
              }
            : undefined,
          topInset,
        );
        applyPerspectivePose(nextView.pose, { syncControls: true });
        return;
      }
    },
    resetView: () => {
      setState({ viewAngle: { ...DEFAULT_VIEW_ANGLE } });

      if (wants2DControls()) {
        const { state } = getViewport2DControlsConfig();
        setViewport2DControlsState({
          gridSpacing: state.gridSpacing,
          scaleFactor: 1,
          offsetX: 0,
          offsetY: 0,
        });
        return;
      }

      if (!getState().isTransitioning3D) {
        const nextView = buildResetViewport3DView(getManagerSnapshot(), getSidebarWidth(), getViewportRect());
        applyPerspectivePose(nextView.pose, { syncControls: true });
        return;
      }
    },
  };
}
