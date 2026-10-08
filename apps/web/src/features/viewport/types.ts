import type { ViewportDirtyFlags } from "./dirtyFlags";

export { DEFAULT_VIEWPORT_RENDER_SNAPSHOT, type ViewportRenderSnapshot } from "@lpviz/viewport/snapshot";

/** What the viewport runtime needs from the canvas it drives. */
export type ViewportBridge = {
  getCanvasElement: () => HTMLCanvasElement;
  getCanvasRect: () => DOMRect;
  invalidate: (options?: { layers?: boolean; viewportDirty?: ViewportDirtyFlags | undefined }) => void;
};
