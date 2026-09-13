import {
  ALL_VIEWPORT_DIRTY,
  getState,
  setState,
  type SolverMode,
} from "@/features/core/store";
import { decodeSharedState } from "@/features/share/compactUrl";
import {
  buildSharedStatePatch,
  expandSharedAppState,
  type ShareSettings,
  type SharedAppState,
} from "@/features/share/sharedState";
import type {
  SolverControl,
  SolverSettingUpdater,
} from "@/features/solver/solverControls";
import { collectZoomFitBounds } from "@/features/viewport/bounds";
import {
  extractSharedObjective3,
  extractSharedPlanes,
  extractSharedVertices3,
} from "@/features/share/sharedState";
import { deriveHullFromPoints3, enumerateVertices3 } from "@lpviz/polytope/polytope3";
import type { PointXYZ } from "@lpviz/math/types";
import type { ViewportApi } from "@/features/viewport/runtime";
import JSONCrush from "jsoncrush";

export function applyUrlParamsOnce({ canvasManager, solverControls, updateSolverSetting, invalidatePendingSolveResults, setActiveSolverMode, sendPolytope }: { canvasManager: ViewportApi; solverControls: SolverControl[]; updateSolverSetting: SolverSettingUpdater; invalidatePendingSolveResults: () => void; setActiveSolverMode: (mode: SolverMode, solve?: boolean) => void; sendPolytope: () => void }) {
  const params = new URLSearchParams(window.location.search);
  const applySharedSettings = (settings: ShareSettings = {}) => {
    if (settings.objectiveAngleStep !== undefined) updateSolverSetting("objectiveAngleStep", settings.objectiveAngleStep);
    if (settings.objectiveRotationSpeed !== undefined) updateSolverSetting("objectiveRotationSpeed", settings.objectiveRotationSpeed);
    solverControls.forEach((c) => c.applySharedSettings(settings));
  };
  const applySharedState = (sharedState: SharedAppState) => {
    invalidatePendingSolveResults();
    setState(
      {
        ...buildSharedStatePatch(sharedState),
        inequalitiesMessage: null,
        highlightIndex: null,
      },
      { viewportDirty: ALL_VIEWPORT_DIRTY },
    );
    applySharedSettings(sharedState.settings);
    if (getState().problemMode === "3d") {
      // /3d links restore the solid directly; zScale stays pinned (real z).
      // Current links carry vertices; older ones carried H-rep planes, whose
      // corners we enumerate and adopt as the vertex set.
      const sharedPlanes = extractSharedPlanes(sharedState);
      const vertices3: PointXYZ[] | null = extractSharedVertices3(sharedState) ?? (sharedPlanes ? enumerateVertices3(sharedPlanes) : null);
      const hull = vertices3 && vertices3.length >= 4 ? deriveHullFromPoints3(vertices3) : null;
      const objective3 = hull ? extractSharedObjective3(sharedState) : null;
      setState(
        {
          zScale: 100,
          ...(hull && hull.kind === "bounded"
            ? {
                vertices3: vertices3!,
                planes: hull.planes,
                polytope3: hull,
                objectiveVector3: objective3,
                currentObjective3: null,
                editor3Phase: objective3 ? ("ready" as const) : ("objective" as const),
              }
            : getState().completionMode !== "draft"
              ? { editor3Phase: "extrude" as const }
              : {}),
        },
        { viewportDirty: ALL_VIEWPORT_DIRTY },
      );
    }
    const state = getState();
    const regionFinished = state.completionMode !== "draft";
    setActiveSolverMode(state.solverMode);
    if (regionFinished) sendPolytope();
    if (sharedState.is3DMode === true && !state.is3DMode && state.problemMode !== "3d") {
      canvasManager.start3DTransition(true);
    }
    // frame a restored 3D solid — a tall model would otherwise open cropped
    if (state.problemMode === "3d" && getState().polytope3) {
      const zoomFit = collectZoomFitBounds(getState());
      if (zoomFit) canvasManager.zoomToFit(zoomFit.bounds, 50, zoomFit.zBounds);
    }
    canvasManager.draw();
  };
  if (!params.has("s")) return;
  try {
    const encoded = params.get("s") ?? "";
    // Links shared before the base64url format are still out in the world —
    // in chat logs, in the README, in a paper — so JSONCrush stays on the read
    // path. Anything in the base64url alphabet with a valid version byte is
    // the current format; everything else falls back.
    const data =
      decodeSharedState(encoded) ??
      (expandSharedAppState(
        JSON.parse(JSONCrush.uncrush(encoded)),
      ) as SharedAppState);
    if (data) applySharedState(data);
    // strip only the consumed param; keep any other query params and the hash
    const url = new URL(window.location.href);
    url.searchParams.delete("s");
    history.replaceState(null, "", url);
  } catch (error) {
    console.error("Failed to load shared state", error);
  }
}
