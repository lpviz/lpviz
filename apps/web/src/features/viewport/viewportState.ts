import type { PointXYZ } from "@lpviz/math/types";
import { DEFAULT_VIEW_ANGLE, DEFAULT_Z_SCALE } from "@lpviz/viewport/defaults";
import type { ViewportDirtyFlags } from "@lpviz/viewport/types";

// The viewport's slice of the store: the 2D/3D view and its transition.
export type ViewportState = {
  is3DMode: boolean;
  viewAngle: PointXYZ;
  zScale: number;
  isTransitioning3D: boolean;
  transitionStartTime: number;
  transition3DStartAngles: PointXYZ;
  transition3DEndAngles: PointXYZ;
  transitionDirection: "to3d" | "to2d" | null;
  transitionProgress: number;
  isNavigatingViewport: boolean;
};

// The fields a reset leaves alone: the 3D view and its transition, which the transition
// controller owns (a reset in 3D mode asks it to return to 2D), plus viewport navigation, which
// mirrors something outside the store.
export type ViewportRuntimeState = Omit<ViewportState, "zScale">;

export function freshViewportState(): Omit<ViewportState, keyof ViewportRuntimeState> {
  return {
    zScale: DEFAULT_Z_SCALE,
  };
}

export function initialViewportRuntimeState(): ViewportRuntimeState {
  return {
    is3DMode: false,
    viewAngle: { ...DEFAULT_VIEW_ANGLE },
    isTransitioning3D: false,
    transitionStartTime: 0,
    transition3DStartAngles: { x: 0, y: 0, z: 0 },
    transition3DEndAngles: { ...DEFAULT_VIEW_ANGLE },
    transitionDirection: null,
    transitionProgress: 0,
    isNavigatingViewport: false,
  };
}

// Which render layers a change to each viewport field repaints (merged into the store's FIELD_DIRTY).
export const VIEWPORT_DIRTY: Partial<Record<keyof ViewportState, () => ViewportDirtyFlags>> = {
  // zScale rescales every world-anchored layer's height
  zScale: () => ({
    polytope: true,
    objective: true,
    trace: true,
    iterate: true,
  }),
};
