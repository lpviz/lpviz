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
      problemMode,
      vertices3,
      objectiveVector3,
      editor3Phase,
    } = getSnapshot();
    // a /3d link shares the solid's vertices (+3D objective); the base
    // sketch's vertices ride along so the sketch/extrude phases round-trip
    const share3D =
      problemMode === "3d" &&
      editor3Phase !== "sketch" &&
      editor3Phase !== "extrude" &&
      vertices3.length >= 4;
    // base64url only, so the whole link survives being pasted into chat,
    // email or a paper without a linkifier clipping its tail
    const encoded = encodeSharedState({
      vertices,
      completionMode,
      objective: objectiveVector,
      solverMode,
      settings: collectShareSettings(solverMode),
      solverStartPoint,
      // /3d pins zScale to real z, so the link need not carry it
      ...(problemMode === "3d" ? {} : { zScale }),
      ...(is3DMode && problemMode !== "3d" ? { is3DMode } : {}),
      ...(share3D ? { vertices3, objective3: objectiveVector3 ?? undefined } : {}),
    });
    window.prompt(
      "Share this link:",
      `${window.location.origin}${window.location.pathname}?s=${encoded}`,
    );
  };
  return { share, collectShareSettings };
}
