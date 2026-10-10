import type { State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { showsDepth } from "@/features/viewport/viewportState";

type ViewState = Pick<State, "is3DMode" | "isTransitioning3D">;

/** Whether the store agrees that the snapshot's mode is what the view shows (a 3D snapshot is stale once the store has left 3D). */
export function viewShowsMode(state: ViewState, snap: Pick<ViewportRenderSnapshot, "mode">): boolean {
  return snap.mode !== "3d" || showsDepth(state);
}

// Whether the 2-variable drawing (the polygon, its vertices, the rubber band and the highlighted
// constraint line) shows. Today that is whenever the view does; a 3-variable solid, once
// extruded, takes the drawing's place here.
export function rendersPlanarDrawing(state: ViewState, snap: Pick<ViewportRenderSnapshot, "mode">): boolean {
  return viewShowsMode(state, snap);
}
