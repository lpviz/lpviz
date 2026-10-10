import { getState, setState } from "@/features/core/store";
import { decodeSharedState } from "@/features/share/compactUrl";
import { decodeLegacySharedState } from "@/features/share/legacyLink";
import { applySharedSettings, buildSharedStatePatch, type SharedAppState } from "@/features/share/sharedState";
import type { SolverMode, SolverSettingUpdater } from "@/features/solver/solverState";
import { ALL_VIEWPORT_DIRTY } from "@/features/viewport/dirtyFlags";
import type { ViewportApi } from "@/features/viewport/runtime";

export function applyUrlParamsOnce({
  viewportApi,
  updateSolverSetting,
  invalidatePendingSolveResults,
  setActiveSolverMode,
  sendPolytope,
}: {
  viewportApi: ViewportApi;
  updateSolverSetting: SolverSettingUpdater;
  invalidatePendingSolveResults: () => void;
  setActiveSolverMode: (mode: SolverMode, solve?: boolean) => void;
  sendPolytope: () => void;
}) {
  const params = new URLSearchParams(window.location.search);
  const applySharedState = (sharedState: SharedAppState) => {
    const { dimension } = getState();
    if (sharedState.dimension !== undefined && sharedState.dimension !== dimension) {
      setState({ inequalitiesMessage: `This link holds a ${sharedState.dimension}-variable problem; this editor draws ${dimension}-variable ones.` });
      return;
    }
    invalidatePendingSolveResults();
    setState({ ...buildSharedStatePatch(sharedState, dimension), inequalitiesMessage: null, highlightIndex: null }, { viewportDirty: ALL_VIEWPORT_DIRTY });
    applySharedSettings(sharedState.settings ?? {}, updateSolverSetting);
    const state = getState();
    const regionFinished = state.completionMode !== "draft";
    setActiveSolverMode(state.solverMode);
    if (regionFinished) sendPolytope();
    if (sharedState.is3DMode === true && !state.is3DMode) viewportApi.start3DTransition(true);
  };
  if (!params.has("s")) return;
  try {
    const encoded = params.get("s") ?? "";
    // anything in the base64url alphabet with a valid version byte is the
    // current format; everything else is a link from before it
    applySharedState(decodeSharedState(encoded) ?? decodeLegacySharedState(encoded));
    // strip only the consumed param; keep any other query params and the hash
    const url = new URL(window.location.href);
    url.searchParams.delete("s");
    history.replaceState(null, "", url);
  } catch (error) {
    console.error("Failed to load shared state", error);
  }
}
