import { getState, setState } from "@/features/core/store";
import { computeEditorRegionForState } from "@/features/polytope-editor/editorSession";

export type PolytopeService = { send: () => void };

export function createPolytopeService(handleProblemChange: () => void): PolytopeService {
  const fail = (inequalitiesMessage: string) => {
    setState({ polytope: null, inequalitiesMessage, highlightIndex: null });
    handleProblemChange();
  };
  const send = () => {
    try {
      const regionResult = computeEditorRegionForState(getState());
      if (regionResult.status === "nonconvex") return fail("Nonconvex");
      const promotion = regionResult.promotion;
      if (promotion)
        setState({
          vertices: promotion.vertices,
          completionMode: promotion.completionMode,
          interiorPoint: promotion.interiorPoint,
        });
      const result = regionResult.polytope;
      const { highlightIndex } = getState();
      setState({
        polytope: result,
        inequalitiesMessage: null,
        ...(highlightIndex !== null && highlightIndex >= result.constraints.length ? { highlightIndex: null } : {}),
      });
      handleProblemChange();
    } catch (error) {
      console.error("Error:", error);
      fail("Error computing the constraints.");
    }
  };
  return { send };
}
