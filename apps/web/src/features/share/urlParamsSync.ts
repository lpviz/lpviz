import { getState, setState } from "@/features/core/store";
import { decodeSharedState } from "@/features/share/compactUrl";
import { decodeLegacySharedState } from "@/features/share/legacyLink";
import { buildSharedStatePatch, type SharedAppState } from "@/features/share/sharedState";
import type { ViewportApi } from "@/features/viewport/runtime";

export function applyUrlParamsOnce({ viewportApi, derivePolytope }: { viewportApi: ViewportApi; derivePolytope: () => void }) {
  const params = new URLSearchParams(window.location.search);
  const applySharedState = (sharedState: SharedAppState) => {
    const current = getState();
    if (sharedState.dimension !== undefined && sharedState.dimension !== current.dimension) {
      setState({ inequalitiesMessage: `This link holds a ${sharedState.dimension}-variable problem; this editor draws ${current.dimension}-variable ones.` });
      return;
    }
    setState({ ...buildSharedStatePatch(sharedState, current), inequalitiesMessage: null, highlightIndex: null });
    const state = getState();
    if (state.completionMode !== "draft") derivePolytope();
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
