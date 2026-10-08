import { getState } from "@/features/core/store";
import { encodeSharedState } from "@/features/share/compactUrl";
import { collectShareSettings } from "@/features/share/sharedState";

export function createShareService() {
  const share = () => {
    const { dimension, vertices, completionMode, objectiveVector, solverMode, solverSettings, zScale, is3DMode, solverStartPoint } = getState();
    // base64url only, so the whole link survives being pasted into chat,
    // email or a paper without a linkifier clipping its tail
    const encoded = encodeSharedState({
      dimension,
      vertices,
      completionMode,
      objective: objectiveVector,
      solverMode,
      settings: collectShareSettings(solverSettings, solverMode),
      solverStartPoint,
      zScale,
      ...(is3DMode ? { is3DMode } : {}),
    });
    window.prompt("Share this link:", `${window.location.origin}${window.location.pathname}?s=${encoded}`);
  };
  return { share };
}
