import { getState, setState } from "@/features/core/store";
import { decodeSharedState, encodeSharedState } from "@/features/share/compactUrl";
import { decodeLegacySharedState } from "@/features/share/legacyLink";
import { buildSharedStatePatch, type SharedAppState, sharedStateOf } from "@/features/share/sharedState";
import type { ViewportApi } from "@/features/viewport/runtime";

// The link at the window: offered in a prompt, and taken from the address on boot.

/** Offer a link to the current problem, solver and view in a prompt, so it can be copied. */
export function shareLink() {
  // base64url only, so the whole link survives being pasted into chat,
  // email or a paper without a linkifier clipping its tail
  const encoded = encodeSharedState(sharedStateOf(getState()));
  window.prompt("Share this link:", `${window.location.origin}${window.location.pathname}?s=${encoded}`);
}

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
