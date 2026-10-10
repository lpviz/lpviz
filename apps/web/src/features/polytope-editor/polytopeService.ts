import { getState, setState } from "@/features/core/store";
import { computeEditorRegionForState } from "@/features/polytope-editor/editorSession";

export type PolytopeService = {
  /** Derive the polytope from the drawing (promoting an open chain that closed up), then re-solve. */
  derive: () => void;
};

export function createPolytopeService(handleProblemChange: () => void): PolytopeService {
  const fail = (inequalitiesMessage: string) => {
    setState({ polytope: null, inequalitiesMessage, highlightIndex: null });
    handleProblemChange();
  };
  const derive = () => {
    try {
      const region = computeEditorRegionForState(getState());
      if (region.status === "nonconvex") return fail("Nonconvex");
      const { highlightIndex } = getState();
      setState({
        ...region.promotion,
        polytope: region.polytope,
        inequalitiesMessage: null,
        // a highlighted constraint that the new region no longer has
        ...(highlightIndex !== null && highlightIndex >= region.polytope.constraints.length ? { highlightIndex: null } : {}),
      });
      handleProblemChange();
    } catch (error) {
      console.error("Error:", error);
      fail("Error computing the constraints.");
    }
  };
  return { derive };
}
