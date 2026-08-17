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
import type { ViewportApi } from "@/features/viewport/runtime";
import JSONCrush from "jsoncrush";

export function applyUrlParamsOnce({
  canvasManager,
  solverControls,
  updateSolverSetting,
  invalidatePendingSolveResults,
  setActiveSolverMode,
  sendPolytope,
}: {
  canvasManager: ViewportApi;
  solverControls: SolverControl[];
  updateSolverSetting: SolverSettingUpdater;
  invalidatePendingSolveResults: () => void;
  setActiveSolverMode: (mode: SolverMode, solve?: boolean) => void;
  sendPolytope: () => void;
}) {
  const params = new URLSearchParams(window.location.search);
  const applySharedSettings = (settings: ShareSettings = {}) => {
    if (settings.objectiveAngleStep !== undefined)
      updateSolverSetting("objectiveAngleStep", settings.objectiveAngleStep);
    if (settings.objectiveRotationSpeed !== undefined)
      updateSolverSetting(
        "objectiveRotationSpeed",
        settings.objectiveRotationSpeed,
      );
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
    const state = getState();
    const regionFinished = state.completionMode !== "draft";
    setActiveSolverMode(state.solverMode);
    if (regionFinished) sendPolytope();
    if (sharedState.is3DMode === true && !state.is3DMode) {
      canvasManager.start3DTransition(true);
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
