import { getState } from "@/features/core/store";
import type { PointXY, Vec } from "@lpviz/math/types";
import { toCanvasCoords2D, toLogicalCoords2D } from "@lpviz/viewport/projection2d";
import { projectWorldPosition3D, toCanvasCoords3D, toLogicalCoords3D } from "@lpviz/viewport/projection3d";
import type { ViewportRuntimeContext } from "./context";
import type { ExternalControlsSync } from "./externalControlsSync";

// The ViewportApi methods that project between canvas and logical coordinates.
export function createCoordsApi({
  shouldUseExternal2DViewport,
  getManagerSnapshot,
  getViewportRect,
  getExternal2DSnapshot,
}: Pick<ViewportRuntimeContext, "shouldUseExternal2DViewport" | "getManagerSnapshot" | "getViewportRect"> & Pick<ExternalControlsSync, "getExternal2DSnapshot">) {
  return {
    toLogicalCoords: (x: number, y: number): PointXY => {
      if (shouldUseExternal2DViewport()) {
        return toLogicalCoords2D(getExternal2DSnapshot(), getViewportRect(), x, y, { snapToGrid: getState().snapToGrid });
      }

      const state = getState();
      const { editorInteraction } = state;
      const viewAnchor3D =
        editorInteraction.kind === "dragging" && (editorInteraction.target.kind === "point" || editorInteraction.target.kind === "objective" || editorInteraction.target.kind === "solver-start")
          ? editorInteraction.target.viewAnchor3D
          : undefined;
      return toLogicalCoords3D(getManagerSnapshot(), getViewportRect(), x, y, {
        zScale: state.zScale,
        snapToGrid: state.snapToGrid,
        editorInteractionKind: state.editorInteraction.kind,
        is3DMode: state.is3DMode,
        isTransitioning3D: state.isTransitioning3D,
        viewAnchor3D,
      });
    },
    toCanvasCoords: (x: number, y: number, z?: number): PointXY => {
      if (shouldUseExternal2DViewport()) {
        return toCanvasCoords2D(getExternal2DSnapshot(), getViewportRect(), {
          x,
          y,
        });
      }

      return toCanvasCoords3D(getManagerSnapshot(), getViewportRect(), { x, y }, z, getState().zScale);
    },
    getObjectiveScreenPosition: (point: Vec): PointXY => {
      if (shouldUseExternal2DViewport()) {
        return toCanvasCoords2D(getExternal2DSnapshot(), getViewportRect(), { x: point[0], y: point[1] });
      }

      return projectWorldPosition3D(getManagerSnapshot(), getViewportRect(), { x: point[0], y: point[1], z: 0 });
    },
  };
}
