import { DEFAULT_VIEW_ANGLE, getState, setState } from "@/features/core/store";
import type { BoundingBox } from "@lpviz/math/bounds";
import { fitViewport2DToBounds } from "@lpviz/viewport/projection2d";
import { buildResetViewport3DView, fitViewport3DToBounds } from "@lpviz/viewport/view3d";
import type { ViewportRuntimeContext } from "./context";
import { getViewport2DControlsConfig, setViewport2DControlsState } from "./controls2d";
import type { ExternalControlsSync } from "./externalControlsSync";

export type ViewportZBounds = {
  minZ: number;
  maxZ: number;
};

// The ViewportApi methods that move the view as a whole: zoomToFit and resetView.
export function createViewFitApi({
  shouldUseExternal2DViewport,
  getManagerSnapshot,
  getViewportRect,
  getSidebarWidth,
  applyExternalPerspectivePose,
}: Pick<ViewportRuntimeContext, "shouldUseExternal2DViewport" | "getManagerSnapshot" | "getViewportRect" | "getSidebarWidth"> & Pick<ExternalControlsSync, "applyExternalPerspectivePose">) {
  return {
    zoomToFit: (bounds: BoundingBox, padding?: number, zBounds?: ViewportZBounds, topInset?: number) => {
      if (shouldUseExternal2DViewport()) {
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
        applyExternalPerspectivePose(nextView.pose, { syncControls: true });
        return;
      }
    },
    resetView: () => {
      setState({ viewAngle: { ...DEFAULT_VIEW_ANGLE } });

      if (shouldUseExternal2DViewport()) {
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
        applyExternalPerspectivePose(nextView.pose, { syncControls: true });
        return;
      }
    },
  };
}
