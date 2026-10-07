import type { ViewportRenderSnapshot } from "@/features/viewport/types";

type ViewState = {
  is3DMode: boolean;
  isTransitioning3D: boolean;
};

export function shouldRenderSnapshotMode(mode: ViewportRenderSnapshot["mode"], state: ViewState) {
  return mode !== "3d" || state.is3DMode || state.isTransitioning3D;
}

// Whether the 2-variable drawing (the polygon, its vertices, the rubber band and the highlighted
// constraint line) shows. Today that is whenever the view does; a 3-variable solid, once
// extruded, takes the drawing's place here.
export function rendersPlanarDrawing(mode: ViewportRenderSnapshot["mode"], state: ViewState) {
  return shouldRenderSnapshotMode(mode, state);
}
