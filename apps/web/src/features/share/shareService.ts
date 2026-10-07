import { getState, type SolverMode } from "@/features/core/store";
import { encodeSharedState } from "@/features/share/compactUrl";
import { GLOBAL_SHARE_KEYS, type ShareSettings } from "@/features/share/sharedState";
import type { SolverControl } from "@/features/solver/solverControls";

export function createShareService(getSolverControls: () => SolverControl[]) {
  const collectShareSettings = (mode: SolverMode): ShareSettings => {
    const settings = getState().solverSettings;
    const solverControl = getSolverControls().find((c) => c.mode === mode);
    return { ...Object.fromEntries(GLOBAL_SHARE_KEYS.map((key) => [key, settings[key]])), ...solverControl?.collectShareSettings() };
  };
  const share = () => {
    const { dimension, vertices, completionMode, objectiveVector, solverMode, zScale, is3DMode, solverStartPoint } = getState();
    // base64url only, so the whole link survives being pasted into chat,
    // email or a paper without a linkifier clipping its tail
    const encoded = encodeSharedState({
      dimension,
      vertices,
      completionMode,
      objective: objectiveVector,
      solverMode,
      settings: collectShareSettings(solverMode),
      solverStartPoint,
      zScale,
      ...(is3DMode ? { is3DMode } : {}),
    });
    window.prompt("Share this link:", `${window.location.origin}${window.location.pathname}?s=${encoded}`);
  };
  return { share };
}
