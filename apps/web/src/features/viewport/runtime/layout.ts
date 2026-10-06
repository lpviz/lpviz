import type { ViewportRuntimeContext } from "./context";
import { setViewport2DControlsConfig } from "./controls2d";
import type { ExternalControlsSync } from "./externalControlsSync";
import type { TransitionController } from "./transitionController";

// The ViewportApi methods that react to a layout change (canvas rect or
// sidebar width): re-derive and republish whichever snapshot is live.
export function createLayoutApi(
  ctx: Pick<ViewportRuntimeContext, "refreshViewportRect" | "setSidebarWidth" | "shouldUseExternal2DViewport" | "isExternal3DControlsActive" | "getManagerSnapshot"> & {
    controls: ExternalControlsSync;
    transition: TransitionController;
  },
) {
  const { controls, transition } = ctx;

  // Shared tail of updateDimensions / setSidebarWidth once the caller has handled the external-2D
  // case: re-derive and republish whichever non-2D snapshot is live (a transition frame, an
  // external-3D rebuild, or the static manager snapshot fallback).
  const republishAfterLayoutChange = () => {
    if (transition.isActive()) {
      transition.republishCurrentFrame();
      return;
    }
    if (ctx.isExternal3DControlsActive()) {
      controls.rebuildExternal3DSnapshot();
      controls.publish3DControlsConfig();
      controls.publishSnapshot(ctx.getManagerSnapshot());
      return;
    }
    controls.publishSnapshot(ctx.getManagerSnapshot());
  };

  return {
    updateDimensions: () => {
      ctx.refreshViewportRect();
      if (ctx.shouldUseExternal2DViewport()) {
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
      if (ctx.shouldUseExternal2DViewport()) {
        controls.syncManagerPlanarState();
        controls.publishSnapshot(controls.getExternal2DSnapshot());
        return;
      }
      republishAfterLayoutChange();
    },
  };
}
