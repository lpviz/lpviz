import { getState, on, onMeta } from "@/features/core/store";
import type { BoundingBox } from "@lpviz/math/bounds";
import type { PointXY, Vec } from "@lpviz/math/types";
import type { ViewportZBounds } from "@lpviz/viewport/snapshot";
import type { ViewportRuntimeContext } from "./runtime/context";
import { resetViewport2DControlsConfig, setViewport2DControlsConfig } from "./runtime/controls2d";
import { resetViewport3DControlsConfig } from "./runtime/controls3d";
import { createCoordsApi } from "./runtime/coords";
import { createControlsSync } from "./runtime/controlsSync";
import { createLayoutApi } from "./runtime/layout";
import { createNavigationIdleTracker } from "./runtime/navigationIdle";
import { resetViewportRenderSnapshot } from "./runtime/snapshot";
import { createTransitionController } from "./runtime/transitionController";
import { createViewFitApi } from "./runtime/viewFit";
import { DEFAULT_VIEWPORT_RENDER_SNAPSHOT, type ViewportBridge, type ViewportRenderSnapshot } from "./types";

const VIEWPORT_UNBOUNDED_EXTENT = 5000;

export type ViewportApi = {
  draw: () => void;
  updateDimensions: () => void;
  setSidebarWidth: (width: number) => void;
  zoomToFit: (
    bounds: BoundingBox,
    padding?: number,
    zBounds?: ViewportZBounds,
    // pixels along the top edge covered by an overlay (the open gallery)
    topInset?: number,
  ) => void;
  resetView: () => void;
  setControlsBlocked: (blocked: boolean) => void;
  set2DPanEnabled: (enabled: boolean) => void;
  toLogicalCoords: (x: number, y: number) => PointXY;
  toCanvasCoords: (x: number, y: number, z?: number) => PointXY;
  getObjectiveScreenPosition: (point: Vec) => PointXY;
  getUnboundedClipBounds: () => BoundingBox;
  start3DTransition: (targetMode: boolean) => void;
  getCanvasElement: () => HTMLCanvasElement;
  getCanvasRect: () => DOMRect;
};

export type ViewportRuntime = ViewportApi & {
  destroy: () => void;
};

export async function createViewportRuntime({ viewportBridge }: { viewportBridge: ViewportBridge }): Promise<ViewportRuntime> {
  let currentSidebarWidth = 0;
  // Snapshot ownership model. At any instant exactly one source owns the render
  // snapshot: the 2D pan/zoom controls, the 3D orbit controls, or the transition
  // animator (the transitionController, created below). The store's
  // is3DMode/isTransitioning3D describe the DESIRED mode; the `*Active` flags
  // below describe which source is currently WIRED UP. The two intentionally
  // diverge for the length of a transition: while isTransitioning3D is true both
  // wants2DControls/wants3DControls() return false, so neither controls source
  // is active, and the controller's isActive() latches on instead so the
  // animator owns the snapshot. Collapsing these into one "mode" enum would
  // conflate desired vs. wired and lose that lag.
  //
  // managerSnapshot is the snapshot the runtime itself owns (3D controls + the
  // transition animator publish through it). It is an immutable VALUE: only the
  // reference is ever reassigned (always to a freshly built snapshot); the
  // object is never mutated, which is what makes publishSnapshot's prev/next
  // diff meaningful.
  let managerSnapshot: ViewportRenderSnapshot = {
    ...DEFAULT_VIEWPORT_RENDER_SNAPSHOT,
  };
  let controls2DActive = false;
  let controls3DActive = false;
  let cachedViewportRect = viewportBridge.getCanvasRect();

  const wants2DControls = () => {
    const state = getState();
    return !state.is3DMode && !state.isTransitioning3D;
  };

  const wants3DControls = () => {
    const state = getState();
    return state.is3DMode && !state.isTransitioning3D;
  };

  const refreshViewportRect = () => {
    cachedViewportRect = viewportBridge.getCanvasRect();
    return cachedViewportRect;
  };

  const getViewportRect = () => cachedViewportRect;

  const navigation = createNavigationIdleTracker({ wants2DControls });

  // the sub-modules reach the fields above only through these accessors
  const ctx: ViewportRuntimeContext = {
    viewportBridge,
    getManagerSnapshot: () => managerSnapshot,
    assignManagerSnapshot: (snapshot) => {
      managerSnapshot = snapshot;
    },
    getViewportRect,
    refreshViewportRect,
    getSidebarWidth: () => currentSidebarWidth,
    setSidebarWidth: (width) => {
      currentSidebarWidth = width;
    },
    are3DControlsActive: () => controls3DActive,
    wants2DControls,
    navigation,
  };
  const controls = createControlsSync(ctx);
  const { publishSnapshot, get2DControlsSnapshot, syncManagerPlanarState, sync2DControls } = controls;

  const sync3DControls = (enabled: boolean, options: { syncFromSnapshot?: boolean } = {}) => {
    controls3DActive = enabled;
    if (enabled) {
      controls.rebuild3DSnapshot();
    }
    controls.publish3DControlsConfig({
      syncFromSnapshot: enabled && options.syncFromSnapshot,
    });
  };

  // the 2D<->3D animator: one of the three snapshot-ownership sources (see the
  // ownership-model comment above). It co-owns managerSnapshot with the runtime,
  // so that is threaded in as get/set.
  const transition = createTransitionController({
    getManagerSnapshot: ctx.getManagerSnapshot,
    setManagerSnapshot: ctx.assignManagerSnapshot,
    getViewportRect,
    getSidebarWidth: ctx.getSidebarWidth,
    wants2DControls,
    are3DControlsActive: ctx.are3DControlsActive,
    get2DControlsSnapshot,
    publishSnapshot,
    syncManagerPlanarState,
    sync2DControls,
    sync3DControls,
    clearActiveNavigation: navigation.clearActiveNavigation,
  });

  controls.initialize();

  controls2DActive = wants2DControls();
  sync2DControls(controls2DActive, {
    syncStateFromSnapshot: controls2DActive,
  });
  sync3DControls(wants3DControls(), {
    syncFromSnapshot: wants3DControls(),
  });
  publishSnapshot(controls2DActive ? get2DControlsSnapshot() : managerSnapshot);

  const subscriptions = new AbortController();
  on(
    ["is3DMode", "isTransitioning3D"],
    () => {
      const next2DControlsActive = wants2DControls();
      const next3DControlsActive = wants3DControls();
      const changed2D = next2DControlsActive !== controls2DActive;
      const changed3D = next3DControlsActive !== controls3DActive;

      if (!changed2D && !changed3D) {
        return;
      }

      sync2DControls(next2DControlsActive);

      if (changed3D) {
        sync3DControls(next3DControlsActive, {
          syncFromSnapshot: next3DControlsActive,
        });
      }

      controls2DActive = next2DControlsActive;

      // the transition animator owns the snapshot until it completes; don't let
      // a mode change mid-transition publish a competing controls snapshot
      if (transition.isActive()) {
        return;
      }

      if (controls2DActive) {
        syncManagerPlanarState();
        sync2DControls(true);
        publishSnapshot(managerSnapshot);
        return;
      }

      publishSnapshot(managerSnapshot);
    },
    subscriptions.signal,
  );

  onMeta((meta) => {
    const viewportDirty = meta?.viewportDirty;
    if (!viewportDirty || Object.keys(viewportDirty).length === 0) {
      return;
    }
    viewportBridge.invalidate({ viewportDirty });
  }, subscriptions.signal);

  return {
    draw: () => {
      viewportBridge.invalidate({ layers: false });
    },
    ...createLayoutApi({ ...ctx, controls, transition }),
    ...createViewFitApi({ ...ctx, applyPerspectivePose: controls.applyPerspectivePose }),
    setControlsBlocked: controls.setControlsBlocked,
    set2DPanEnabled: (enabled) => {
      setViewport2DControlsConfig({ panEnabled: enabled });
    },
    ...createCoordsApi({ ...ctx, get2DControlsSnapshot }),
    getUnboundedClipBounds: () => ({ minX: -VIEWPORT_UNBOUNDED_EXTENT, maxX: VIEWPORT_UNBOUNDED_EXTENT, minY: -VIEWPORT_UNBOUNDED_EXTENT, maxY: VIEWPORT_UNBOUNDED_EXTENT }),
    start3DTransition: (targetMode) => transition.begin(targetMode),
    getCanvasElement: () => viewportBridge.getCanvasElement(),
    getCanvasRect: () => getViewportRect(),
    destroy: () => {
      navigation.clearActiveNavigation();
      transition.reset();
      resetViewport2DControlsConfig();
      resetViewport3DControlsConfig();
      subscriptions.abort();
      resetViewportRenderSnapshot();
    },
  };
}
