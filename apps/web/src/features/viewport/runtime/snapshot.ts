import { createSignal } from "@/features/core/signal";
import { DEFAULT_VIEWPORT_RENDER_SNAPSHOT, type ViewportRenderSnapshot } from "../types";

// Fires on every snapshot update (camera pose included); the render loop is
// demand-driven by the dirty flags, so one listener tier is enough.
export const {
  set: setViewportRenderSnapshot,
  reset: resetViewportRenderSnapshot,
  subscribe: subscribeViewportRenderSnapshot,
  get: getViewportRenderSnapshot,
} = createSignal<ViewportRenderSnapshot>(DEFAULT_VIEWPORT_RENDER_SNAPSHOT);
