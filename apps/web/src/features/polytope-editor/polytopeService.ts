import { getState, setState } from "@/features/core/store";
import { computeEditorRegionForState } from "@/features/polytope-editor/editorSession";

export type PolytopeService = { send: () => void };

export function createPolytopeService(handleProblemChange: () => void): PolytopeService {
  const send = () => {
    try {
      const regionResult = computeEditorRegionForState(getState());
      if (regionResult.status === "nonconvex") {
        setState({
          polytope: null,
          inequalitiesMessage: "Nonconvex",
          highlightIndex: null,
        });
        handleProblemChange();
        return;
      }
      const promotion = regionResult.promotion;
      if (promotion)
        setState({
          vertices: promotion.vertices,
          completionMode: promotion.completionMode,
          interiorPoint: promotion.interiorPoint,
        });
      const result = regionResult.polytope;
      if (!result.inequalities) {
        setState({
          polytope: null,
          inequalitiesMessage: "No inequalities returned.",
          highlightIndex: null,
        });
        handleProblemChange();
        return;
      }
      const { highlightIndex } = getState();
      setState({
        polytope: result,
        inequalitiesMessage: null,
        ...(highlightIndex !== null && highlightIndex >= result.inequalities.length ? { highlightIndex: null } : {}),
      });
      handleProblemChange();
    } catch (error) {
      console.error("Error:", error);
      setState({
        polytope: null,
        inequalitiesMessage: "Error computing inequalities.",
        highlightIndex: null,
      });
      handleProblemChange();
    }
  };
  return { send };
}
