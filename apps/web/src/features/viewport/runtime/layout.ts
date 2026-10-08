import type { ViewportRuntimeContext } from "./context";
import { setViewport2DControlsConfig } from "./controls2d";
import type { ControlsSync } from "./controlsSync";
import type { TransitionController } from "./transitionController";

// The ViewportApi methods that react to a layout change (canvas rect or
// sidebar width): re-derive and republish whichever snapshot is live.
export function createLayoutApi(
  ctx: Pick<ViewportRuntimeContext, "refreshViewportRect" | "setSidebarWidth" | "wants2DControls" | "are3DControlsActive" | "getManagerSnapshot"> & {
    controls: ControlsSync;
    transition: TransitionController;
  },
) {
  const { controls, transition } = ctx;

  // Shared tail of updateDimensions / setSidebarWidth once the caller has handled the 2D-controls
  // case: re-derive and republish whichever non-2D snapshot is live (a transition frame, a
  // 3D-controls rebuild, or the static manager snapshot fallback).
  const republishAfterLayoutChange = () => {
    if (transition.isActive()) {
      transition.republishCurrentFrame();
      return;
    }
    if (ctx.are3DControlsActive()) {
      controls.rebuild3DSnapshot();
      controls.publish3DControlsConfig();
      controls.publishSnapshot(ctx.getManagerSnapshot());
      return;
    }
    controls.publishSnapshot(ctx.getManagerSnapshot());
  };

  return {
    updateDimensions: () => {
      ctx.refreshViewportRect();
      if (ctx.wants2DControls()) {
        controls.syncManagerPlanarState();
        controls.publishSnapshot(ctx.getManagerSnapshot());
        return;
      }
      republishAfterLayoutChange();
    },
    setSidebarWidth: (width: number) => {
      ctx.setSidebarWidth(width);
      ctx.refreshViewportRect();
      setViewport2DControlsConfig({ sidebarWidth: width });
      if (ctx.wants2DControls()) {
        controls.syncManagerPlanarState();
        controls.publishSnapshot(controls.get2DControlsSnapshot());
        return;
      }
      republishAfterLayoutChange();
    },
  };
}
