import type { ViewportRenderSnapshot } from "@/features/viewport/types";

export function shouldRenderSnapshotMode(
  mode: ViewportRenderSnapshot["mode"],
  state: {
    is3DMode: boolean;
    isTransitioning3D: boolean;
  },
) {
  return mode !== "3d" || state.is3DMode || state.isTransitioning3D;
}

// Once the 3-variable editor has committed a solid (post-extrude), the flat
// base-polygon layers hand rendering over to Polytope3DLayer entirely — the
// base fill/edges/vertices at z=0 would z-fight with the prism's bottom face.
export function is3DSolidActive(state: { problemMode: "2d" | "3d"; editor3Phase: "sketch" | "extrude" | "objective" | "ready" }): boolean {
  return state.problemMode === "3d" && state.editor3Phase !== "sketch" && state.editor3Phase !== "extrude";
}
