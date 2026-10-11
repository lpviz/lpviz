import type { Repaint } from "./dirtyFlags";

export { DEFAULT_VIEWPORT_RENDER_SNAPSHOT, type ViewportRenderSnapshot } from "@lpviz/viewport/snapshot";

/** What the viewport runtime needs from the canvas it drives. */
export type ViewportBridge = {
  getCanvasElement: () => HTMLCanvasElement;
  getCanvasRect: () => DOMRect;
  invalidate: (repaint?: Repaint) => void;
  /** Run `tick` at the start of every frame the canvas renders; returns the removal. */
  addTick: (tick: () => void) => () => void;
};
