import { getState } from "@/features/core/store";
import type { PointXY, Vec } from "@lpviz/math/types";
import { toCanvasCoords2D, toLogicalCoords2D } from "@lpviz/viewport/projection2d";
import { projectWorldPosition3D, toCanvasCoords3D, toLogicalCoords3D } from "@lpviz/viewport/projection3d";
import type { ViewportRuntimeContext } from "./context";
import type { ControlsSync } from "./controlsSync";

// The ViewportApi methods that project between canvas and logical coordinates.
export function createCoordsApi({
  wants2DControls,
  getManagerSnapshot,
  getViewportRect,
  get2DControlsSnapshot,
}: Pick<ViewportRuntimeContext, "wants2DControls" | "getManagerSnapshot" | "getViewportRect"> & Pick<ControlsSync, "get2DControlsSnapshot">) {
  return {
    toLogicalCoords: (x: number, y: number): PointXY => {
      const point = { x, y };
      if (wants2DControls()) {
        return toLogicalCoords2D(get2DControlsSnapshot(), getViewportRect(), point, { snapToGrid: getState().snapToGrid });
      }

      const state = getState();
      const { editorInteraction } = state;
      const viewAnchor3D =
        editorInteraction.kind === "dragging" && (editorInteraction.target.kind === "point" || editorInteraction.target.kind === "objective" || editorInteraction.target.kind === "solver-start")
          ? editorInteraction.target.viewAnchor3D
          : undefined;
      return toLogicalCoords3D(getManagerSnapshot(), getViewportRect(), point, {
        zScale: state.zScale,
        snapToGrid: state.snapToGrid,
        interacting: editorInteraction.kind !== "idle",
        viewAnchor3D,
      });
    },
    toCanvasCoords: (x: number, y: number, z?: number): PointXY => {
      if (wants2DControls()) {
        return toCanvasCoords2D(get2DControlsSnapshot(), getViewportRect(), {
          x,
          y,
        });
      }

      return toCanvasCoords3D(getManagerSnapshot(), getViewportRect(), { x, y }, z, getState().zScale);
    },
    getObjectiveScreenPosition: (point: Vec): PointXY => {
      if (wants2DControls()) {
        return toCanvasCoords2D(get2DControlsSnapshot(), getViewportRect(), { x: point[0], y: point[1] });
      }

      return projectWorldPosition3D(getManagerSnapshot(), getViewportRect(), { x: point[0], y: point[1], z: 0 });
    },
  };
}
