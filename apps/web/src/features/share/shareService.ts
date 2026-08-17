import { getSnapshot, getState, type SolverMode } from "@/features/core/store";
import { encodeSharedState } from "@/features/share/compactUrl";
import type { ShareSettings } from "@/features/share/sharedState";
import type { SolverControl } from "@/features/solver/solverControls";

export function createShareService(getSolverControls: () => SolverControl[]) {
  const collectShareSettings = (mode: SolverMode): ShareSettings => {
    const settings = getState().solverSettings;
    const solverControl = getSolverControls().find((c) => c.mode === mode);
    return {
      objectiveAngleStep: settings.objectiveAngleStep,
      objectiveRotationSpeed: settings.objectiveRotationSpeed,
      ...(solverControl?.collectShareSettings() ?? {}),
    };
  };
  const share = () => {
    const {
      vertices,
      completionMode,
      objectiveVector,
      solverMode,
      zScale,
      is3DMode,
      solverStartPoint,
    } = getSnapshot();
    // base64url only, so the whole link survives being pasted into chat,
    // email or a paper without a linkifier clipping its tail
    const encoded = encodeSharedState({
      vertices,
      completionMode,
      objective: objectiveVector,
      solverMode,
      settings: collectShareSettings(solverMode),
      solverStartPoint,
      zScale,
      ...(is3DMode ? { is3DMode } : {}),
    });
    window.prompt(
      "Share this link:",
      `${window.location.origin}${window.location.pathname}?s=${encoded}`,
    );
  };
  return { share, collectShareSettings };
}
