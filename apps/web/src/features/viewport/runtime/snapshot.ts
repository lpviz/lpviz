import { DEFAULT_VIEWPORT_RENDER_SNAPSHOT, type ViewportRenderSnapshot } from "../types";

let snapshot = DEFAULT_VIEWPORT_RENDER_SNAPSHOT;
// Fire on every snapshot update (camera pose included). The render loop is
// already demand-driven by the dirty-flag system, so a single listener tier is
// enough — the only subscriber is CameraController.
const listeners = new Set<() => void>();

export function setViewportRenderSnapshot(next: ViewportRenderSnapshot): void {
  snapshot = next;
  listeners.forEach((l) => l());
}

export function resetViewportRenderSnapshot(): void {
  snapshot = DEFAULT_VIEWPORT_RENDER_SNAPSHOT;
  listeners.forEach((l) => l());
}

export function subscribeFullViewportRenderSnapshot(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getViewportRenderSnapshot(): ViewportRenderSnapshot {
  return snapshot;
}
