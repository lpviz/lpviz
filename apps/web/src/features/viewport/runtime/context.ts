import type { ViewportBridge, ViewportRenderSnapshot } from "../types";
import type { NavigationIdleTracker } from "./navigationIdle";

// Accessors for the runtime's shared mutable fields, handed to its
// sub-modules as getters/setters so each field has exactly one owner (the
// runtime) and one copy.
export type ViewportRuntimeContext = {
  viewportBridge: ViewportBridge;
  // the snapshot the runtime owns; see the ownership comment in runtime.ts
  getManagerSnapshot: () => ViewportRenderSnapshot;
  // reassign the reference only (the value is immutable); does not republish
  assignManagerSnapshot: (snapshot: ViewportRenderSnapshot) => void;
  getViewportRect: () => DOMRect;
  refreshViewportRect: () => DOMRect;
  getSidebarWidth: () => number;
  setSidebarWidth: (width: number) => void;
  // the ownership flag: whether the 3D orbit controls are wired up
  are3DControlsActive: () => boolean;
  wants2DControls: () => boolean;
  navigation: NavigationIdleTracker;
};
