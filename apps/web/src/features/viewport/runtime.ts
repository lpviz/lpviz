import {
  DEFAULT_VIEW_ANGLE,
  getDisplayedIterateZ,
  getState,
  setState,
  on,
  onMeta,
} from "@/features/core/store";
import type { BoundingBox } from "@lpviz/math/geometry";
import type { PointXY } from "@lpviz/math/types";
import {
  buildViewport2DSnapshot,
  fitViewport2DToBounds,
  isDefault2DView,
  toCanvasCoords2D,
  toLogicalCoords2D,
} from "@lpviz/viewport/projection2d";
import {
  getObjectiveScreenPosition3D,
  toCanvasCoords3D,
  toLogicalCoords3D,
} from "@lpviz/viewport/projection3d";
import { buildPerspectivePoseFromViewAngle } from "@lpviz/viewport/transition";
import {
  buildResetViewport3DView,
  buildViewport3DSnapshot,
  fitViewport3DToBounds,
  getDefaultPerspectiveDistance3D,
  getMaxPerspectiveDistance3D,
  isDefault3DView,
} from "@lpviz/viewport/view3d";
import {
  getViewportUnboundedClipBounds,
  isViewport3DState,
} from "./dirtyFlags";
import { getSnapshotViewportDirtyFlags } from "./snapshotDirty";
import {
  getViewport2DControlsConfig,
  getViewport2DControlsSnapshot,
  resetViewport2DControlsConfig,
  setViewport2DControlsConfig,
  setViewport2DControlsState,
  syncViewport2DControlsStateFromSnapshot,
} from "./runtime/controls2d";
import {
  resetViewport3DControlsConfig,
  setViewport3DControlsConfig,
} from "./runtime/controls3d";
import {
  getViewportRenderSnapshot,
  resetViewportRenderSnapshot,
  setViewportRenderSnapshot,
} from "./runtime/snapshot";
import { createTransitionController } from "./runtime/transitionController";
import {
  DEFAULT_VIEWPORT_RENDER_SNAPSHOT,
  type ViewportBridge,
  type ViewportRenderSnapshot,
} from "./types";

const VIEWPORT_NAVIGATION_IDLE_MS = 100;


type ViewportZBounds = {
  minZ: number;
  maxZ: number;
};

export type ViewportApi = {
  draw: () => void;
  updateDimensions: () => void;
  setSidebarWidth: (width: number) => void;
  setNavigationFrameCallback: (callback: (() => void) | null) => void;
  isDefaultView: () => boolean;
  setViewState: (scale: number, offsetX: number, offsetY: number) => void;
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
  getObjectiveScreenPosition: (point: PointXY) => PointXY;
  getUnboundedClipBounds: () => BoundingBox;
  start3DTransition: (targetMode: boolean) => void;
  getCanvasElement: () => HTMLCanvasElement;
  getCanvasRect: () => DOMRect;
};

export type ViewportRuntime = ViewportApi & {
  destroy: () => void;
};

export async function createViewportRuntime({
  viewportBridge,
}: {
  viewportBridge: ViewportBridge;
}): Promise<ViewportRuntime> {
  let currentSidebarWidth = 0;
  let navigationFrameCallback: (() => void) | null = null;
  let navigationIdleTimeoutId: number | null = null;
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
  let externalControlsBlocked = false;
  let external2DViewportActive = false;
  let external3DControlsActive = false;
  // bumped to signal subscribers (3D controls bridge) to re-sync from config
  let external3DControlsSyncToken = 0;
  let cachedViewportRect = viewportBridge.getCanvasRect();

  const shouldUseExternal2DViewport = () => {
    const state = getState();
    return !state.is3DMode && !state.isTransitioning3D;
  };

  const shouldUseExternal3DControls = () => {
    const state = getState();
    return state.is3DMode && !state.isTransitioning3D;
  };

  const isExternalViewportNavigationOwned = () =>
    shouldUseExternal2DViewport() || shouldUseExternal3DControls();

  const setViewportNavigationActive = (active: boolean) => {
    if (getState().isNavigatingViewport === active) {
      return;
    }
    setState({ isNavigatingViewport: active }, { viewportDirty: {} });
  };

  const clearViewportNavigationTimeout = () => {
    if (navigationIdleTimeoutId !== null) {
      clearTimeout(navigationIdleTimeoutId);
      navigationIdleTimeoutId = null;
    }
  };

  const beginViewportNavigation = () => {
    if (!isExternalViewportNavigationOwned()) {
      return;
    }
    clearViewportNavigationTimeout();
    setViewportNavigationActive(true);
  };

  const scheduleViewportNavigationEnd = () => {
    clearViewportNavigationTimeout();
    navigationIdleTimeoutId = window.setTimeout(() => {
      navigationIdleTimeoutId = null;
      if (!isExternalViewportNavigationOwned()) {
        return;
      }
      setViewportNavigationActive(false);
    }, VIEWPORT_NAVIGATION_IDLE_MS);
  };

  const notifyViewportNavigationFrame = () => {
    if (!shouldUseExternal2DViewport()) {
      return;
    }
    beginViewportNavigation();
    navigationFrameCallback?.();
    scheduleViewportNavigationEnd();
  };

  const publishSnapshot = (snapshot: ViewportRenderSnapshot) => {
    const previousSnapshot = getViewportRenderSnapshot();
    setViewportRenderSnapshot(snapshot);
    const viewportDirty = getSnapshotViewportDirtyFlags(
      previousSnapshot,
      snapshot,
    );
    const hasLayerDirty = Object.keys(viewportDirty).length > 0;
    viewportBridge.invalidate({
      layers: hasLayerDirty,
      viewportDirty: hasLayerDirty ? viewportDirty : undefined,
    });
  };

  const refreshViewportRect = () => {
    cachedViewportRect = viewportBridge.getCanvasRect();
    return cachedViewportRect;
  };

  const getViewportRect = () => cachedViewportRect;

  const buildPoseFromSnapshot = (snapshot: ViewportRenderSnapshot) => ({
    position: { ...snapshot.perspective.position },
    up: { ...snapshot.perspective.up },
    target: { ...snapshot.target },
  });

  const rebuildExternal3DSnapshot = (
    pose = buildPoseFromSnapshot(managerSnapshot),
  ) => {
    managerSnapshot = buildViewport3DSnapshot(
      managerSnapshot,
      pose,
      getViewportRect(),
    );
    return managerSnapshot;
  };

  const getExternal2DSnapshot = () =>
    getViewport2DControlsSnapshot(getViewportRect());

  const buildInitialSnapshot = () => {
    const initial2DSnapshot = getExternal2DSnapshot();
    const state = getState();
    if (!isViewport3DState(state)) {
      return initial2DSnapshot;
    }

    const pose = buildPerspectivePoseFromViewAngle(
      state.viewAngle,
      getDefaultPerspectiveDistance3D(initial2DSnapshot, getViewportRect()),
      initial2DSnapshot.target,
    );
    return buildViewport3DSnapshot(initial2DSnapshot, pose, getViewportRect());
  };

  const syncManagerPlanarState = () => {
    managerSnapshot = getExternal2DSnapshot();
    setViewport2DControlsConfig(
      {
        sidebarWidth: currentSidebarWidth,
        fallbackSnapshot: managerSnapshot,
      },
      { emit: false },
    );
  };

  const applyExternalPerspectivePose = (
    pose: {
      position: { x: number; y: number; z: number };
      up: { x: number; y: number; z: number };
      target: { x: number; y: number; z: number };
    },
    options: { syncControls?: boolean } = {},
  ) => {
    const previousScaleFactor = managerSnapshot.scaleFactor;
    rebuildExternal3DSnapshot(pose);
    if (Math.abs(managerSnapshot.scaleFactor - previousScaleFactor) > 1e-6) {
      setState({}, { viewportDirty: { objective: true } });
    }
    if (external3DControlsActive && options.syncControls) {
      publish3DControlsConfig({ syncFromSnapshot: true });
    }
    publishSnapshot(managerSnapshot);
  };

  const publish3DControlsConfig = ({
    syncFromSnapshot = false,
  }: {
    syncFromSnapshot?: boolean;
  } = {}) => {
    if (syncFromSnapshot) {
      external3DControlsSyncToken += 1;
    }

    setViewport3DControlsConfig({
      enabled: external3DControlsActive,
      blocked: externalControlsBlocked,
      maxDistance: getMaxPerspectiveDistance3D(
        managerSnapshot,
        getViewportRect(),
      ),
      syncToken: external3DControlsSyncToken,
      snapshot: managerSnapshot,
      onStart: () => {
        beginViewportNavigation();
        scheduleViewportNavigationEnd();
      },
      onChange: (pose) => {
        applyExternalPerspectivePose(pose);
        beginViewportNavigation();
        navigationFrameCallback?.();
        scheduleViewportNavigationEnd();
      },
      onEnd: () => {
        scheduleViewportNavigationEnd();
      },
    });
  };

  const syncExternal2DControls = (
    enabled: boolean,
    options: { syncStateFromSnapshot?: boolean } = {},
  ) => {
    if (options.syncStateFromSnapshot) {
      syncViewport2DControlsStateFromSnapshot(
        managerSnapshot,
        currentSidebarWidth,
        { emit: false },
      );
    }

    setViewport2DControlsConfig(
      {
        enabled,
        blocked: externalControlsBlocked,
        sidebarWidth: currentSidebarWidth,
        fallbackSnapshot: managerSnapshot,
      },
      { emit: false },
    );
  };

  const syncExternal3DControls = (
    enabled: boolean,
    options: { syncFromSnapshot?: boolean } = {},
  ) => {
    external3DControlsActive = enabled;
    if (enabled) {
      rebuildExternal3DSnapshot();
    }
    publish3DControlsConfig({
      syncFromSnapshot: enabled && options.syncFromSnapshot,
    });
  };

  // the 2D<->3D animator: one of the three snapshot-ownership sources (see the
  // ownership-model comment above). It co-owns managerSnapshot with the runtime,
  // so that is threaded in as get/set.
  const transition = createTransitionController({
    getManagerSnapshot: () => managerSnapshot,
    setManagerSnapshot: (snapshot) => {
      managerSnapshot = snapshot;
    },
    getViewportRect,
    getSidebarWidth: () => currentSidebarWidth,
    shouldUseExternal2DViewport,
    isExternal3DControlsActive: () => external3DControlsActive,
    getExternal2DSnapshot,
    publishSnapshot,
    syncManagerPlanarState,
    syncExternal2DControls,
    syncExternal3DControls,
    clearActiveNavigation: () => {
      clearViewportNavigationTimeout();
      setViewportNavigationActive(false);
    },
  });

  setViewport2DControlsConfig(
    {
      enabled: false,
      blocked: externalControlsBlocked,
      panEnabled: true,
      sidebarWidth: currentSidebarWidth,
      fallbackSnapshot: managerSnapshot,
      onStateChange: (state) => {
        managerSnapshot = buildViewport2DSnapshot(
          state,
          currentSidebarWidth,
          getViewportRect(),
          managerSnapshot,
        );
        setViewport2DControlsConfig(
          {
            sidebarWidth: currentSidebarWidth,
            fallbackSnapshot: managerSnapshot,
          },
          { emit: false },
        );
        publishSnapshot(managerSnapshot);
      },
      onNavigationFrame: () => {
        notifyViewportNavigationFrame();
      },
    },
    { emit: false },
  );
  syncViewport2DControlsStateFromSnapshot(
    managerSnapshot,
    currentSidebarWidth,
    {
      emit: false,
    },
  );
  managerSnapshot = buildInitialSnapshot();
  setViewport2DControlsConfig(
    {
      sidebarWidth: currentSidebarWidth,
      fallbackSnapshot: managerSnapshot,
    },
    { emit: false },
  );

  external2DViewportActive = shouldUseExternal2DViewport();
  syncExternal2DControls(external2DViewportActive, {
    syncStateFromSnapshot: external2DViewportActive,
  });
  syncExternal3DControls(shouldUseExternal3DControls(), {
    syncFromSnapshot: shouldUseExternal3DControls(),
  });
  publishSnapshot(
    external2DViewportActive ? getExternal2DSnapshot() : managerSnapshot,
  );

  const externalOwnershipController = new AbortController();
  on(
    ["is3DMode", "isTransitioning3D"],
    () => {
      const nextExternal2DViewportActive = shouldUseExternal2DViewport();
      const nextExternal3DControlsActive = shouldUseExternal3DControls();
      const external2DChanged =
        nextExternal2DViewportActive !== external2DViewportActive;
      const external3DChanged =
        nextExternal3DControlsActive !== external3DControlsActive;

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
        managerSnapshot = getExternal2DSnapshot();
        setViewport2DControlsConfig(
          {
            sidebarWidth: currentSidebarWidth,
            fallbackSnapshot: managerSnapshot,
          },
          { emit: false },
        );
        syncExternal2DControls(true);
        publishSnapshot(managerSnapshot);
        return;
      }

      publishSnapshot(managerSnapshot);
    },
    externalOwnershipController.signal,
  );

  const viewportDirtyController = new AbortController();
  onMeta((meta) => {
    const viewportDirty = meta?.viewportDirty;
    if (!viewportDirty || Object.keys(viewportDirty).length === 0) {
      return;
    }
    viewportBridge.invalidate({ viewportDirty });
  }, viewportDirtyController.signal);

  // Shared tail of the layout-change handlers (updateDimensions /
  // setSidebarWidth): once the external-2D case is handled by the caller, a
  // layout change must re-derive and republish whichever non-2D snapshot is
  // live — a transition frame, an external-3D rebuild, or the static manager
  // snapshot fallback.
  const republishAfterLayoutChange = () => {
    if (transition.isActive()) {
      transition.republishCurrentFrame();
      return;
    }
    if (external3DControlsActive) {
      rebuildExternal3DSnapshot();
      publish3DControlsConfig();
      publishSnapshot(managerSnapshot);
      return;
    }
    publishSnapshot(managerSnapshot);
  };

  return {
    draw: () => {
      viewportBridge.invalidate({ layers: false });
    },
    updateDimensions: () => {
      refreshViewportRect();
      if (shouldUseExternal2DViewport()) {
        managerSnapshot = getExternal2DSnapshot();
        setViewport2DControlsConfig(
          {
            sidebarWidth: currentSidebarWidth,
            fallbackSnapshot: managerSnapshot,
          },
          { emit: false },
        );
        publishSnapshot(managerSnapshot);
        return;
      }
      republishAfterLayoutChange();
    },
    setSidebarWidth: (width) => {
      currentSidebarWidth = width;
      refreshViewportRect();
      setViewport2DControlsConfig({ sidebarWidth: width }, { emit: false });
      if (shouldUseExternal2DViewport()) {
        syncManagerPlanarState();
        publishSnapshot(getExternal2DSnapshot());
        return;
      }
      republishAfterLayoutChange();
    },
    setNavigationFrameCallback: (callback) => {
      navigationFrameCallback = callback;
    },
    isDefaultView: () => {
      if (shouldUseExternal2DViewport()) {
        return isDefault2DView(
          getExternal2DSnapshot(),
          getViewport2DControlsConfig().sidebarWidth,
        );
      }

      if (!getState().isTransitioning3D) {
        return isDefault3DView(
          managerSnapshot,
          currentSidebarWidth,
          getViewportRect(),
        );
      }

      return false;
    },
    setViewState: (scale, offsetX, offsetY) => {
      const { state } = getViewport2DControlsConfig();
      const nextPlanarState = {
        gridSpacing: state.gridSpacing,
        scaleFactor: scale,
        offsetX,
        offsetY,
      };

      if (shouldUseExternal2DViewport()) {
        setViewport2DControlsState(nextPlanarState);
        return;
      }

      setViewport2DControlsState(nextPlanarState, {
        notify: false,
        emit: false,
      });
      managerSnapshot = buildViewport2DSnapshot(
        nextPlanarState,
        currentSidebarWidth,
        getViewportRect(),
        managerSnapshot,
      );
      setViewport2DControlsConfig(
        {
          sidebarWidth: currentSidebarWidth,
          fallbackSnapshot: managerSnapshot,
        },
        { emit: false },
      );
    },
    zoomToFit: (bounds, padding, zBounds, topInset) => {
      if (shouldUseExternal2DViewport()) {
        const { state, sidebarWidth } = getViewport2DControlsConfig();
        setViewport2DControlsState(
          fitViewport2DToBounds(
            state,
            sidebarWidth,
            getViewportRect(),
            managerSnapshot,
            bounds,
            padding,
            topInset,
          ),
        );
        return;
      }

      if (!getState().isTransitioning3D) {
        const state = getState();
        const nextView = fitViewport3DToBounds(
          managerSnapshot,
          getViewportRect(),
          currentSidebarWidth,
          bounds,
          padding,
          zBounds
            ? {
                minZ: (zBounds.minZ * state.zScale) / 100,
                maxZ: (zBounds.maxZ * state.zScale) / 100,
              }
            : undefined,
          topInset,
        );
        if (!nextView) {
          return;
        }
        applyExternalPerspectivePose(nextView.pose, { syncControls: true });
        return;
      }

      return;
    },
    resetView: () => {
      setState({ viewAngle: { ...DEFAULT_VIEW_ANGLE } }, { viewportDirty: {} });

      if (shouldUseExternal2DViewport()) {
        const { state } = getViewport2DControlsConfig();
        setViewport2DControlsState({
          gridSpacing: state.gridSpacing,
          scaleFactor: 1,
          offsetX: 0,
          offsetY: 0,
        });
        return;
      }

      if (!getState().isTransitioning3D) {
        const nextView = buildResetViewport3DView(
          managerSnapshot,
          currentSidebarWidth,
          getViewportRect(),
        );
        applyExternalPerspectivePose(nextView.pose, { syncControls: true });
        return;
      }

      return;
    },
    setControlsBlocked: (blocked) => {
      externalControlsBlocked = blocked;
      setViewport2DControlsConfig({ blocked }, { emit: false });
      if (external3DControlsActive) {
        publish3DControlsConfig();
      }
    },
    set2DPanEnabled: (enabled) => {
      setViewport2DControlsConfig({ panEnabled: enabled }, { emit: false });
    },
    toLogicalCoords: (x, y) => {
      if (shouldUseExternal2DViewport()) {
        return toLogicalCoords2D(
          getExternal2DSnapshot(),
          getViewportRect(),
          x,
          y,
          { snapToGrid: getState().snapToGrid },
        );
      }

      const state = getState();
      const { editorInteraction } = state;
      const viewAnchor3D =
        editorInteraction.kind === "dragging" &&
        (editorInteraction.target.kind === "point" ||
          editorInteraction.target.kind === "objective" ||
          editorInteraction.target.kind === "solver-start")
          ? editorInteraction.target.viewAnchor3D
          : undefined;
      return toLogicalCoords3D(managerSnapshot, getViewportRect(), x, y, {
        objectiveVector: state.objectiveVector,
        zScale: state.zScale,
        snapToGrid: state.snapToGrid,
        editorInteractionKind: state.editorInteraction.kind,
        is3DMode: state.is3DMode,
        isTransitioning3D: state.isTransitioning3D,
        viewAnchor3D,
      });
    },
    toCanvasCoords: (x, y, z) => {
      if (shouldUseExternal2DViewport()) {
        return toCanvasCoords2D(getExternal2DSnapshot(), getViewportRect(), {
          x,
          y,
        });
      }

      return toCanvasCoords3D(
        managerSnapshot,
        getViewportRect(),
        { x, y },
        z,
        getState().zScale,
        getDisplayedIterateZ,
      );
    },
    getObjectiveScreenPosition: (point) => {
      if (shouldUseExternal2DViewport()) {
        return toCanvasCoords2D(
          getExternal2DSnapshot(),
          getViewportRect(),
          point,
        );
      }

      return getObjectiveScreenPosition3D(
        managerSnapshot,
        getViewportRect(),
        point,
      );
    },
    getUnboundedClipBounds: () => getViewportUnboundedClipBounds(),
    start3DTransition: (targetMode) => transition.begin(targetMode),
    getCanvasElement: () => viewportBridge.getCanvasElement(),
    getCanvasRect: () => getViewportRect() as DOMRect,
    destroy: () => {
      clearViewportNavigationTimeout();
      setViewportNavigationActive(false);
      transition.reset();
      resetViewport2DControlsConfig();
      resetViewport3DControlsConfig();
      externalOwnershipController.abort();
      viewportDirtyController.abort();
      resetViewportRenderSnapshot();
    },
  };
}
