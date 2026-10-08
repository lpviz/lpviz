import { getState, on, onMeta } from "@/features/core/store";
import type { BoundingBox } from "@lpviz/math/bounds";
import type { PointXY, Vec } from "@lpviz/math/types";
import type { ViewportRuntimeContext } from "./runtime/context";
import { resetViewport2DControlsConfig, setViewport2DControlsConfig } from "./runtime/controls2d";
import { resetViewport3DControlsConfig } from "./runtime/controls3d";
import { createCoordsApi } from "./runtime/coords";
import { createExternalControlsSync } from "./runtime/externalControlsSync";
import { createLayoutApi } from "./runtime/layout";
import { createNavigationIdleTracker } from "./runtime/navigationIdle";
import { resetViewportRenderSnapshot } from "./runtime/snapshot";
import { createTransitionController } from "./runtime/transitionController";
import { createViewFitApi, type ViewportZBounds } from "./runtime/viewFit";
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
  // snapshot: the external 2D viewport controls, the external 3D orbit controls,
  // or the transition animator (the transitionController, created below). The
  // store's is3DMode/isTransitioning3D describe the DESIRED mode; the `*Active`
  // flags below describe which source is currently WIRED UP. The two
  // intentionally diverge for the length of a transition: while isTransitioning3D
  // is true both shouldUseExternal2D/3D() return false, so neither controls
  // source is active, and the controller's isActive() latches on instead so the
  // animator owns the snapshot. Collapsing these into one "mode" enum would
  // conflate desired vs. wired and lose that lag — see memory note
  // viewport-ownership-consolidation.
  //
  // managerSnapshot is the snapshot the runtime itself owns (3D controls + the
  // transition animator publish through it). It is an immutable VALUE: only the
  // reference is ever reassigned (always to a freshly built snapshot); the
  // object is never mutated, which is what makes publishSnapshot's prev/next
  // diff meaningful.
  let managerSnapshot: ViewportRenderSnapshot = {
    ...DEFAULT_VIEWPORT_RENDER_SNAPSHOT,
  };
  let external2DViewportActive = false;
  let external3DControlsActive = false;
  let cachedViewportRect = viewportBridge.getCanvasRect();

  const shouldUseExternal2DViewport = () => {
    const state = getState();
    return !state.is3DMode && !state.isTransitioning3D;
  };

  const shouldUseExternal3DControls = () => {
    const state = getState();
    return state.is3DMode && !state.isTransitioning3D;
  };

  const refreshViewportRect = () => {
    cachedViewportRect = viewportBridge.getCanvasRect();
    return cachedViewportRect;
  };

  const getViewportRect = () => cachedViewportRect;

  const navigation = createNavigationIdleTracker({ shouldUseExternal2DViewport });

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
    isExternal3DControlsActive: () => external3DControlsActive,
    shouldUseExternal2DViewport,
    navigation,
  };
  const controls = createExternalControlsSync(ctx);
  const { publishSnapshot, getExternal2DSnapshot, syncManagerPlanarState, syncExternal2DControls } = controls;

  const syncExternal3DControls = (enabled: boolean, options: { syncFromSnapshot?: boolean } = {}) => {
    external3DControlsActive = enabled;
    if (enabled) {
      controls.rebuildExternal3DSnapshot();
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
    shouldUseExternal2DViewport,
    isExternal3DControlsActive: ctx.isExternal3DControlsActive,
    getExternal2DSnapshot,
    publishSnapshot,
    syncManagerPlanarState,
    syncExternal2DControls,
    syncExternal3DControls,
    clearActiveNavigation: navigation.clearActiveNavigation,
  });

  controls.initialize();

  external2DViewportActive = shouldUseExternal2DViewport();
  syncExternal2DControls(external2DViewportActive, {
    syncStateFromSnapshot: external2DViewportActive,
  });
  syncExternal3DControls(shouldUseExternal3DControls(), {
    syncFromSnapshot: shouldUseExternal3DControls(),
  });
  publishSnapshot(external2DViewportActive ? getExternal2DSnapshot() : managerSnapshot);

  const subscriptions = new AbortController();
  on(
    ["is3DMode", "isTransitioning3D"],
    () => {
      const nextExternal2DViewportActive = shouldUseExternal2DViewport();
      const nextExternal3DControlsActive = shouldUseExternal3DControls();
      const external2DChanged = nextExternal2DViewportActive !== external2DViewportActive;
      const external3DChanged = nextExternal3DControlsActive !== external3DControlsActive;

      if (!external2DChanged && !external3DChanged) {
        return;
      }

      syncExternal2DControls(nextExternal2DViewportActive);

      if (external3DChanged) {
        syncExternal3DControls(nextExternal3DControlsActive, {
          syncFromSnapshot: nextExternal3DControlsActive,
        });
      }

      external2DViewportActive = nextExternal2DViewportActive;

      // the transition animator owns the snapshot until it completes; don't let
      // a mode change mid-transition publish a competing controls snapshot
      if (transition.isActive()) {
        return;
      }

      if (external2DViewportActive) {
        syncManagerPlanarState();
        syncExternal2DControls(true);
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
    ...createViewFitApi({ ...ctx, applyExternalPerspectivePose: controls.applyExternalPerspectivePose }),
    setControlsBlocked: controls.setControlsBlocked,
    set2DPanEnabled: (enabled) => {
      setViewport2DControlsConfig({ panEnabled: enabled });
    },
    ...createCoordsApi({ ...ctx, getExternal2DSnapshot }),
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
