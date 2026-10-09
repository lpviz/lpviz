import { DEFAULT_VIEW_ANGLE, getState, on, onMeta, setState, type State } from "@/features/core/store";
import type { BoundingBox } from "@lpviz/math/bounds";
import type { PointXY, Vec } from "@lpviz/math/types";
import { buildPerspectivePoseFromViewAngle } from "@lpviz/viewport/perspective";
import { buildViewport2DSnapshot, deriveViewport2DState, fitViewport2DToBounds, toCanvasCoords2D, toLogicalCoords2D, type Viewport2DState } from "@lpviz/viewport/projection2d";
import { projectWorldPosition3D, toCanvasCoords3D, toLogicalCoords3D } from "@lpviz/viewport/projection3d";
import type { ViewportPerspectivePose, ViewportZBounds } from "@lpviz/viewport/snapshot";
import { buildViewport2DStateFromTransitionFrame, buildViewportTransitionFrame, buildViewportTransitionPlan, type ViewportTransitionPlan } from "@lpviz/viewport/transition";
import {
  buildResetViewport3DView,
  buildViewport3DSnapshot,
  fitViewport3DToBounds,
  getDefaultPerspectiveDistance3D,
  getMaxPerspectiveDistance3D,
  getViewAngleFromSnapshot3D,
} from "@lpviz/viewport/view3d";
import { UNBOUNDED_CLIP_BOUNDS } from "./bounds";
import { WORLD_ANCHORED_DIRTY } from "./dirtyFlags";
import { get2DControlsConfig, reset2DControlsConfig, set2DControlsConfig, type Viewport2DControlsConfig } from "./runtime/controls2d";
import { resetViewport3DControlsConfig, setViewport3DControlsConfig } from "./runtime/controls3d";
import { getViewportRenderSnapshot, resetViewportRenderSnapshot, setViewportRenderSnapshot } from "./runtime/snapshot";
import { resetViewportTransitionConfig, setViewportTransitionConfig } from "./runtime/transitionConfig";
import { getSnapshotViewportDirtyFlags } from "./snapshotDirty";
import { DEFAULT_VIEWPORT_RENDER_SNAPSHOT, type ViewportBridge, type ViewportRenderSnapshot } from "./types";

const VIEWPORT_NAVIGATION_IDLE_MS = 100;

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

// The store's view of a transition: set when it starts, cleared when it completes.
const transitionStartPatch = (targetMode: boolean, startTime: number, plan: ViewportTransitionPlan): Partial<State> => ({
  isTransitioning3D: true,
  transitionStartTime: startTime,
  transition3DStartAngles: { ...plan.startAngles },
  transition3DEndAngles: { ...plan.endAngles },
  transitionDirection: plan.direction,
  transitionProgress: 0,
  is3DMode: targetMode,
  viewAngle: { ...plan.startAngles },
});

const transitionCompletePatch = (plan: ViewportTransitionPlan): Partial<State> => ({ isTransitioning3D: false, transitionDirection: null, transitionProgress: 0, viewAngle: { ...plan.endAngles } });

const poseOf = (snapshot: ViewportRenderSnapshot): ViewportPerspectivePose => ({
  position: { ...snapshot.perspective.position },
  up: { ...snapshot.perspective.up },
  target: { ...snapshot.target },
});

/**
 * The viewport runtime: the one place that decides who owns the render snapshot and publishes it
 * to the canvas. At any instant exactly one source owns it: the 2D pan/zoom controls, the 3D
 * orbit controls, or the 2D<->3D transition animator. The store's is3DMode/isTransitioning3D
 * describe the DESIRED mode; the `*Active` flags describe which controls are currently WIRED UP.
 * The two intentionally diverge for the length of a transition: while isTransitioning3D is true
 * neither controls source is wanted, and the transition latches on instead. Collapsing these into
 * one "mode" enum would conflate desired vs. wired and lose that lag.
 *
 * `managerSnapshot` is the snapshot the runtime itself owns (the 3D controls and the transition
 * publish through it). It is an immutable VALUE: only the reference is ever reassigned, always to
 * a freshly built snapshot, which is what makes publishSnapshot's prev/next diff meaningful.
 */
export async function createViewportRuntime({ viewportBridge }: { viewportBridge: ViewportBridge }): Promise<ViewportRuntime> {
  let managerSnapshot: ViewportRenderSnapshot = { ...DEFAULT_VIEWPORT_RENDER_SNAPSHOT };
  let controls2DActive = false;
  let controls3DActive = false;
  let sidebarWidth = 0;
  let rect = viewportBridge.getCanvasRect();
  let controlsBlocked = false;
  // bumped to make the orbit controls re-pose their camera from the config's snapshot
  let controls3DSyncToken = 0;

  const wants2DControls = () => {
    const state = getState();
    return !state.is3DMode && !state.isTransitioning3D;
  };
  const wants3DControls = () => {
    const state = getState();
    return state.is3DMode && !state.isTransitioning3D;
  };

  const publishSnapshot = (snapshot: ViewportRenderSnapshot) => {
    const previousSnapshot = getViewportRenderSnapshot();
    setViewportRenderSnapshot(snapshot);
    const viewportDirty = getSnapshotViewportDirtyFlags(previousSnapshot, snapshot);
    const hasLayerDirty = Object.keys(viewportDirty).length > 0;
    viewportBridge.invalidate({ layers: hasLayerDirty, viewportDirty: hasLayerDirty ? viewportDirty : undefined });
  };

  // ---- the 2D controls ----
  const patch2DControls = (patch: Partial<Viewport2DControlsConfig>) => set2DControlsConfig({ ...get2DControlsConfig(), ...patch });
  const get2DControlsSnapshot = () => {
    const config = get2DControlsConfig();
    return buildViewport2DSnapshot(config.state, config.sidebarWidth, rect, config.fallbackSnapshot);
  };
  // the 2D controls fall back to the manager snapshot, so every reassignment
  // of it is also published to them
  const setManagerSnapshot = (snapshot: ViewportRenderSnapshot) => {
    managerSnapshot = snapshot;
    patch2DControls({ sidebarWidth, fallbackSnapshot: snapshot });
  };
  const syncManagerPlanarState = () => setManagerSnapshot(get2DControlsSnapshot());
  // a 2D state the controls or a fit produced: adopt it as the manager snapshot and publish it
  const adopt2DState = (state: Viewport2DState) => {
    patch2DControls({ state });
    setManagerSnapshot(buildViewport2DSnapshot(state, sidebarWidth, rect, managerSnapshot));
    publishSnapshot(managerSnapshot);
  };
  const sync2DControls = (enabled: boolean, options: { syncStateFromSnapshot?: boolean } = {}) => {
    if (options.syncStateFromSnapshot) {
      patch2DControls({ sidebarWidth, fallbackSnapshot: managerSnapshot, state: deriveViewport2DState(managerSnapshot, sidebarWidth) });
    }
    patch2DControls({ enabled, blocked: controlsBlocked, sidebarWidth, fallbackSnapshot: managerSnapshot });
  };

  // ---- navigation: store.isNavigatingViewport is set while a gesture moves the view and
  // cleared VIEWPORT_NAVIGATION_IDLE_MS after its last frame ----
  let navigationIdleTimeout: number | null = null;
  // the 2D or the 3D controls own navigation whenever no transition runs
  const controlsOwnNavigation = () => !getState().isTransitioning3D;
  const setNavigating = (active: boolean) => {
    if (getState().isNavigatingViewport !== active) setState({ isNavigatingViewport: active });
  };
  const clearNavigationTimeout = () => {
    if (navigationIdleTimeout !== null) clearTimeout(navigationIdleTimeout);
    navigationIdleTimeout = null;
  };
  const beginNavigation = () => {
    if (!controlsOwnNavigation()) return;
    clearNavigationTimeout();
    setNavigating(true);
  };
  const scheduleNavigationEnd = () => {
    clearNavigationTimeout();
    navigationIdleTimeout = window.setTimeout(() => {
      navigationIdleTimeout = null;
      if (controlsOwnNavigation()) setNavigating(false);
    }, VIEWPORT_NAVIGATION_IDLE_MS);
  };
  const clearActiveNavigation = () => {
    clearNavigationTimeout();
    setNavigating(false);
  };

  // ---- the 3D controls ----
  const rebuild3DSnapshot = (pose = poseOf(managerSnapshot)) => {
    managerSnapshot = buildViewport3DSnapshot(managerSnapshot, pose, rect);
  };
  const publish3DControlsConfig = ({ syncFromSnapshot = false }: { syncFromSnapshot?: boolean | undefined } = {}) => {
    if (syncFromSnapshot) controls3DSyncToken += 1;
    setViewport3DControlsConfig({
      enabled: controls3DActive,
      blocked: controlsBlocked,
      maxDistance: getMaxPerspectiveDistance3D(managerSnapshot, rect),
      syncToken: controls3DSyncToken,
      snapshot: managerSnapshot,
      onStart: () => {
        beginNavigation();
        scheduleNavigationEnd();
      },
      onChange: (pose) => {
        applyPerspectivePose(pose);
        beginNavigation();
        scheduleNavigationEnd();
      },
      onEnd: scheduleNavigationEnd,
    });
  };
  const applyPerspectivePose = (pose: ViewportPerspectivePose, options: { syncControls?: boolean } = {}) => {
    const previousScaleFactor = managerSnapshot.scaleFactor;
    rebuild3DSnapshot(pose);
    if (Math.abs(managerSnapshot.scaleFactor - previousScaleFactor) > 1e-6) {
      // the objective head keeps a constant screen size, so a zoom redraws it
      viewportBridge.invalidate({ viewportDirty: { objective: true } });
    }
    if (controls3DActive && options.syncControls) publish3DControlsConfig({ syncFromSnapshot: true });
    publishSnapshot(managerSnapshot);
  };
  const sync3DControls = (enabled: boolean, options: { syncFromSnapshot?: boolean } = {}) => {
    controls3DActive = enabled;
    if (enabled) rebuild3DSnapshot();
    publish3DControlsConfig({ syncFromSnapshot: enabled && options.syncFromSnapshot });
  };

  // ---- the transition: owns the snapshot from begin to complete ----
  let transitionRun = 0;
  let transitionActive = false;
  let transitionProgress = 0;
  let transitionPlan: ViewportTransitionPlan | null = null;

  // Derive the frame at `progress` and adopt it as the manager snapshot. While a to-2D transition
  // runs, the 2D controls' planar state follows the frame so the handoff at completion is seamless.
  const renderTransitionFrame = (plan: ViewportTransitionPlan, progress: number) => {
    const frame = buildViewportTransitionFrame(plan, progress, rect);
    if (plan.direction === "to2d") {
      patch2DControls({ sidebarWidth, fallbackSnapshot: frame.snapshot, state: buildViewport2DStateFromTransitionFrame(plan, frame, rect, sidebarWidth) });
    }
    managerSnapshot = frame.snapshot;
    return frame;
  };
  const republishTransitionFrame = () => {
    if (transitionPlan) publishSnapshot(renderTransitionFrame(transitionPlan, transitionProgress).snapshot);
  };
  const resetTransition = () => {
    transitionActive = false;
    transitionPlan = null;
    resetViewportTransitionConfig();
  };
  const beginTransition = (targetMode: boolean) => {
    if (getState().isTransitioning3D) return;

    // If the user was actively panning, the navigation-end timeout will fire
    // during the transition when ownership is unclaimed (isTransitioning3D is
    // true) and silently bail out, leaving isNavigatingViewport stuck true.
    // Clear it now, before the transition disables the controls that set it.
    clearActiveNavigation();

    const baseSnapshot = wants2DControls() ? get2DControlsSnapshot() : managerSnapshot;
    const viewAngle = controls3DActive ? getViewAngleFromSnapshot3D(baseSnapshot) : getState().viewAngle;
    const startTime = performance.now();

    if (wants2DControls()) {
      syncManagerPlanarState();
      sync2DControls(false);
    }
    if (controls3DActive) {
      setState({ viewAngle });
      sync3DControls(false);
    }

    const plan = buildViewportTransitionPlan({ snapshot: baseSnapshot, targetMode, viewAngle });
    transitionActive = true;
    transitionPlan = plan;
    transitionProgress = 0;
    setState(transitionStartPatch(targetMode, startTime, plan), { viewportDirty: WORLD_ANCHORED_DIRTY });
    publishSnapshot(renderTransitionFrame(plan, 0).snapshot);

    transitionRun += 1;
    setViewportTransitionConfig({
      active: true,
      runId: transitionRun,
      startTime,
      duration: plan.duration,
      onFrame: (_progress, easedProgress) => {
        if (!transitionPlan) return;
        transitionProgress = easedProgress;
        publishSnapshot(renderTransitionFrame(transitionPlan, easedProgress).snapshot);
      },
      onComplete: () => {
        const completed = transitionPlan;
        if (completed) {
          transitionProgress = 1;
          renderTransitionFrame(completed, 1);
        }
        // Synchronous mode switch: clear the latch before setState so the
        // store subscription sees the transition inactive and activates the
        // 2D/3D controls without an extra RAF delay.
        transitionActive = false;
        transitionPlan = null;
        if (completed) setState(transitionCompletePatch(completed), { viewportDirty: WORLD_ANCHORED_DIRTY });
        resetViewportTransitionConfig();
        publishSnapshot(wants2DControls() ? get2DControlsSnapshot() : managerSnapshot);
      },
    });
  };

  // ---- layout: re-derive and republish whichever snapshot is live ----
  const republishAfterLayoutChange = () => {
    if (transitionActive) {
      republishTransitionFrame();
      return;
    }
    if (controls3DActive) {
      rebuild3DSnapshot();
      publish3DControlsConfig();
    }
    publishSnapshot(managerSnapshot);
  };

  // ---- initial ownership ----
  // the 2D controls' snapshot as-is in 2D mode, or lifted into the stored view
  // angle's perspective when the app starts in (or transitioning to) 3D
  const initialSnapshot = (planar: ViewportRenderSnapshot) => {
    const state = getState();
    if (!state.is3DMode && !state.isTransitioning3D) return planar;
    return buildViewport3DSnapshot(planar, buildPerspectivePoseFromViewAngle(state.viewAngle, getDefaultPerspectiveDistance3D(planar, rect), planar.target), rect);
  };
  set2DControlsConfig({
    enabled: false,
    blocked: controlsBlocked,
    panEnabled: true,
    sidebarWidth,
    state: deriveViewport2DState(managerSnapshot, sidebarWidth),
    fallbackSnapshot: managerSnapshot,
    onStateChange: adopt2DState,
    onNavigationFrame: () => {
      if (!wants2DControls()) return;
      beginNavigation();
      scheduleNavigationEnd();
    },
  });
  setManagerSnapshot(initialSnapshot(get2DControlsSnapshot()));
  controls2DActive = wants2DControls();
  sync2DControls(controls2DActive, { syncStateFromSnapshot: controls2DActive });
  sync3DControls(wants3DControls(), { syncFromSnapshot: wants3DControls() });
  publishSnapshot(controls2DActive ? get2DControlsSnapshot() : managerSnapshot);

  const subscriptions = new AbortController();
  on(
    ["is3DMode", "isTransitioning3D"],
    () => {
      const next2DActive = wants2DControls();
      const next3DActive = wants3DControls();
      const changed3D = next3DActive !== controls3DActive;
      if (next2DActive === controls2DActive && !changed3D) return;

      sync2DControls(next2DActive);
      if (changed3D) sync3DControls(next3DActive, { syncFromSnapshot: next3DActive });
      controls2DActive = next2DActive;

      // the transition owns the snapshot until it completes; don't let a mode
      // change mid-transition publish a competing controls snapshot
      if (transitionActive) return;
      if (controls2DActive) {
        syncManagerPlanarState();
        sync2DControls(true);
      }
      publishSnapshot(managerSnapshot);
    },
    subscriptions.signal,
  );
  onMeta((meta) => {
    const viewportDirty = meta?.viewportDirty;
    if (viewportDirty && Object.keys(viewportDirty).length > 0) viewportBridge.invalidate({ viewportDirty });
  }, subscriptions.signal);

  const planar = () => wants2DControls();

  return {
    draw: () => viewportBridge.invalidate({ layers: false }),
    updateDimensions: () => {
      rect = viewportBridge.getCanvasRect();
      if (planar()) {
        syncManagerPlanarState();
        publishSnapshot(managerSnapshot);
        return;
      }
      republishAfterLayoutChange();
    },
    setSidebarWidth: (width) => {
      sidebarWidth = width;
      rect = viewportBridge.getCanvasRect();
      patch2DControls({ sidebarWidth: width });
      if (planar()) {
        syncManagerPlanarState();
        publishSnapshot(get2DControlsSnapshot());
        return;
      }
      republishAfterLayoutChange();
    },
    zoomToFit: (bounds, padding, zBounds, topInset) => {
      if (planar()) {
        const config = get2DControlsConfig();
        adopt2DState(fitViewport2DToBounds(config.state, config.sidebarWidth, rect, managerSnapshot, bounds, padding, topInset));
        return;
      }
      const state = getState();
      if (state.isTransitioning3D) return;
      const scaledZ = zBounds ? { minZ: (zBounds.minZ * state.zScale) / 100, maxZ: (zBounds.maxZ * state.zScale) / 100 } : undefined;
      applyPerspectivePose(fitViewport3DToBounds(managerSnapshot, rect, sidebarWidth, bounds, padding, scaledZ, topInset).pose, { syncControls: true });
    },
    resetView: () => {
      setState({ viewAngle: { ...DEFAULT_VIEW_ANGLE } });
      if (planar()) {
        adopt2DState({ gridSpacing: get2DControlsConfig().state.gridSpacing, scaleFactor: 1, offsetX: 0, offsetY: 0 });
        return;
      }
      if (getState().isTransitioning3D) return;
      applyPerspectivePose(buildResetViewport3DView(managerSnapshot, sidebarWidth, rect).pose, { syncControls: true });
    },
    setControlsBlocked: (blocked) => {
      controlsBlocked = blocked;
      patch2DControls({ blocked });
      if (controls3DActive) publish3DControlsConfig();
    },
    set2DPanEnabled: (enabled) => patch2DControls({ panEnabled: enabled }),
    toLogicalCoords: (x, y) => {
      const point = { x, y };
      const state = getState();
      if (planar()) return toLogicalCoords2D(get2DControlsSnapshot(), rect, point, { snapToGrid: state.snapToGrid });
      const { editorInteraction } = state;
      const viewAnchor3D =
        editorInteraction.kind === "dragging" && (editorInteraction.target.kind === "point" || editorInteraction.target.kind === "objective" || editorInteraction.target.kind === "solver-start")
          ? editorInteraction.target.viewAnchor3D
          : undefined;
      return toLogicalCoords3D(managerSnapshot, rect, point, { zScale: state.zScale, snapToGrid: state.snapToGrid, interacting: editorInteraction.kind !== "idle", viewAnchor3D });
    },
    toCanvasCoords: (x, y, z) => (planar() ? toCanvasCoords2D(get2DControlsSnapshot(), rect, { x, y }) : toCanvasCoords3D(managerSnapshot, rect, { x, y }, z, getState().zScale)),
    getObjectiveScreenPosition: (point) =>
      planar() ? toCanvasCoords2D(get2DControlsSnapshot(), rect, { x: point[0], y: point[1] }) : projectWorldPosition3D(managerSnapshot, rect, { x: point[0], y: point[1], z: 0 }),
    getUnboundedClipBounds: () => UNBOUNDED_CLIP_BOUNDS,
    start3DTransition: beginTransition,
    getCanvasElement: () => viewportBridge.getCanvasElement(),
    getCanvasRect: () => rect,
    destroy: () => {
      clearActiveNavigation();
      resetTransition();
      reset2DControlsConfig();
      resetViewport3DControlsConfig();
      subscriptions.abort();
      resetViewportRenderSnapshot();
    },
  };
}
