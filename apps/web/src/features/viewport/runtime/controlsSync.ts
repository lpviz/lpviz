import { getState } from "@/features/core/store";
import { buildViewport2DSnapshot } from "@lpviz/viewport/projection2d";
import { buildPerspectivePoseFromViewAngle } from "@lpviz/viewport/perspective";
import type { ViewportPerspectivePose } from "@lpviz/viewport/snapshot";
import { buildViewport3DSnapshot, getDefaultPerspectiveDistance3D, getMaxPerspectiveDistance3D } from "@lpviz/viewport/view3d";
import { getSnapshotViewportDirtyFlags } from "../snapshotDirty";
import type { ViewportRenderSnapshot } from "../types";
import type { ViewportRuntimeContext } from "./context";
import { getViewport2DControlsSnapshot, setViewport2DControlsConfig, syncViewport2DControlsStateFromSnapshot } from "./controls2d";
import { setViewport3DControlsConfig } from "./controls3d";
import { getViewportRenderSnapshot, setViewportRenderSnapshot } from "./snapshot";

const buildPoseFromSnapshot = (snapshot: ViewportRenderSnapshot) => ({
  position: { ...snapshot.perspective.position },
  up: { ...snapshot.perspective.up },
  target: { ...snapshot.target },
});

// the 2D controls' snapshot as-is in 2D mode, or lifted into the stored view
// angle's perspective when the app starts in (or transitioning to) 3D
function buildInitialSnapshot(initial2DSnapshot: ViewportRenderSnapshot, rect: DOMRect) {
  const state = getState();
  if (!state.is3DMode && !state.isTransitioning3D) {
    return initial2DSnapshot;
  }

  const pose = buildPerspectivePoseFromViewAngle(state.viewAngle, getDefaultPerspectiveDistance3D(initial2DSnapshot, rect), initial2DSnapshot.target);
  return buildViewport3DSnapshot(initial2DSnapshot, pose, rect);
}

export type ControlsSync = ReturnType<typeof createControlsSync>;

// Keeps the 2D pan/zoom controls and the 3D orbit controls configured from the
// runtime's state, and publishes render snapshots to the canvas. Owns the
// controls' blocked flag and the 3D re-sync token; reads the manager snapshot,
// sidebar width and the 3D ownership flag through `ctx`.
export function createControlsSync(
  ctx: Pick<ViewportRuntimeContext, "viewportBridge" | "getManagerSnapshot" | "assignManagerSnapshot" | "getViewportRect" | "getSidebarWidth" | "are3DControlsActive" | "navigation">,
) {
  let controlsBlocked = false;
  // bumped to signal subscribers (3D controls bridge) to re-sync from config
  let controls3DSyncToken = 0;

  const publishSnapshot = (snapshot: ViewportRenderSnapshot) => {
    const previousSnapshot = getViewportRenderSnapshot();
    setViewportRenderSnapshot(snapshot);
    const viewportDirty = getSnapshotViewportDirtyFlags(previousSnapshot, snapshot);
    const hasLayerDirty = Object.keys(viewportDirty).length > 0;
    ctx.viewportBridge.invalidate({
      layers: hasLayerDirty,
      viewportDirty: hasLayerDirty ? viewportDirty : undefined,
    });
  };

  const rebuild3DSnapshot = (pose = buildPoseFromSnapshot(ctx.getManagerSnapshot())) => {
    ctx.assignManagerSnapshot(buildViewport3DSnapshot(ctx.getManagerSnapshot(), pose, ctx.getViewportRect()));
    return ctx.getManagerSnapshot();
  };

  const get2DControlsSnapshot = () => getViewport2DControlsSnapshot(ctx.getViewportRect());

  // the 2D controls fall back to the manager snapshot, so every reassignment
  // of it is also published to them
  const setManagerSnapshot = (snapshot: ViewportRenderSnapshot) => {
    ctx.assignManagerSnapshot(snapshot);
    setViewport2DControlsConfig({ sidebarWidth: ctx.getSidebarWidth(), fallbackSnapshot: ctx.getManagerSnapshot() });
  };

  const syncManagerPlanarState = () => setManagerSnapshot(get2DControlsSnapshot());

  const applyPerspectivePose = (pose: ViewportPerspectivePose, options: { syncControls?: boolean } = {}) => {
    const previousScaleFactor = ctx.getManagerSnapshot().scaleFactor;
    rebuild3DSnapshot(pose);
    if (Math.abs(ctx.getManagerSnapshot().scaleFactor - previousScaleFactor) > 1e-6) {
      // the objective head keeps a constant screen size, so a zoom redraws it
      ctx.viewportBridge.invalidate({ viewportDirty: { objective: true } });
    }
    if (ctx.are3DControlsActive() && options.syncControls) {
      publish3DControlsConfig({ syncFromSnapshot: true });
    }
    publishSnapshot(ctx.getManagerSnapshot());
  };

  const publish3DControlsConfig = ({
    syncFromSnapshot = false,
  }: {
    syncFromSnapshot?: boolean | undefined;
  } = {}) => {
    if (syncFromSnapshot) {
      controls3DSyncToken += 1;
    }

    setViewport3DControlsConfig({
      enabled: ctx.are3DControlsActive(),
      blocked: controlsBlocked,
      maxDistance: getMaxPerspectiveDistance3D(ctx.getManagerSnapshot(), ctx.getViewportRect()),
      syncToken: controls3DSyncToken,
      snapshot: ctx.getManagerSnapshot(),
      onStart: () => {
        ctx.navigation.beginViewportNavigation();
        ctx.navigation.scheduleViewportNavigationEnd();
      },
      onChange: (pose) => {
        applyPerspectivePose(pose);
        ctx.navigation.beginViewportNavigation();
        ctx.navigation.scheduleViewportNavigationEnd();
      },
      onEnd: () => {
        ctx.navigation.scheduleViewportNavigationEnd();
      },
    });
  };

  const sync2DControls = (enabled: boolean, options: { syncStateFromSnapshot?: boolean } = {}) => {
    if (options.syncStateFromSnapshot) {
      syncViewport2DControlsStateFromSnapshot(ctx.getManagerSnapshot(), ctx.getSidebarWidth());
    }

    setViewport2DControlsConfig({
      enabled,
      blocked: controlsBlocked,
      sidebarWidth: ctx.getSidebarWidth(),
      fallbackSnapshot: ctx.getManagerSnapshot(),
    });
  };

  const setControlsBlocked = (blocked: boolean) => {
    controlsBlocked = blocked;
    setViewport2DControlsConfig({ blocked });
    if (ctx.are3DControlsActive()) {
      publish3DControlsConfig();
    }
  };

  // install the 2D controls bridge config (disabled until ownership is
  // decided) and seed the manager snapshot from the current mode
  const initialize = () => {
    setViewport2DControlsConfig({
      enabled: false,
      blocked: controlsBlocked,
      panEnabled: true,
      sidebarWidth: ctx.getSidebarWidth(),
      fallbackSnapshot: ctx.getManagerSnapshot(),
      onStateChange: (state) => {
        setManagerSnapshot(buildViewport2DSnapshot(state, ctx.getSidebarWidth(), ctx.getViewportRect(), ctx.getManagerSnapshot()));
        publishSnapshot(ctx.getManagerSnapshot());
      },
      onNavigationFrame: () => {
        ctx.navigation.notifyViewportNavigationFrame();
      },
    });
    syncViewport2DControlsStateFromSnapshot(ctx.getManagerSnapshot(), ctx.getSidebarWidth());
    setManagerSnapshot(buildInitialSnapshot(get2DControlsSnapshot(), ctx.getViewportRect()));
  };

  return {
    publishSnapshot,
    get2DControlsSnapshot,
    syncManagerPlanarState,
    rebuild3DSnapshot,
    applyPerspectivePose,
    publish3DControlsConfig,
    sync2DControls,
    setControlsBlocked,
    initialize,
  };
}
