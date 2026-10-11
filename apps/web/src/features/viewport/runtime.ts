import { visibleBounds } from "@/features/viewport/bounds";
import { restartableTimeout } from "@/features/core/timers";
import { subscribeCurrentMouse } from "@/features/core/currentMouse";
import { getState, on, onViewportDirty, setState } from "@/features/core/store";
import type { BoundingBox } from "@lpviz/math/bounds";
import type { PointXY } from "@lpviz/math/types";
import { DEFAULT_VIEW_ANGLE } from "@lpviz/viewport/defaults";
import { poseOf } from "@lpviz/viewport/snapshot";
import { buildPerspectivePoseFromViewAngle } from "@lpviz/viewport/perspective";
import { buildViewport2DSnapshot, deriveViewport2DState, fitViewport2DToBounds, toCanvasCoords2D, toLogicalCoords2D, type Viewport2DState } from "@lpviz/viewport/projection2d";
import { toCanvasCoords3D, toLogicalCoords3D } from "@lpviz/viewport/projection3d";
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
import { get2DControlsConfig, reset2DControlsConfig, set2DControlsConfig, type Controls2DConfig } from "./runtime/controls2d";
import { reset3DControlsConfig, set3DControlsConfig } from "./runtime/controls3d";
import { getViewportRenderSnapshot, resetViewportRenderSnapshot, setViewportRenderSnapshot } from "./runtime/snapshot";
import { resetTransitionConfig, setTransitionConfig } from "./runtime/transitionConfig";
import { getSnapshotViewportDirtyFlags } from "./snapshotDirty";
import { DEFAULT_VIEWPORT_RENDER_SNAPSHOT, type ViewportBridge, type ViewportRenderSnapshot } from "./types";
import { showsDepth } from "./viewportState";

const VIEWPORT_NAVIGATION_IDLE_MS = 100;

export type ViewportApi = {
  /** the sidebar's width changed, which resized the canvas too */
  setSidebarWidth: (width: number) => void;
  zoomToFit: (
    bounds: BoundingBox,
    zBounds?: ViewportZBounds,
    // pixels along the top edge covered by an overlay (the open gallery)
    topInset?: number,
  ) => void;
  resetView: () => void;
  setControlsBlocked: (blocked: boolean) => void;
  set2DPanEnabled: (enabled: boolean) => void;
  toLogicalCoords: (x: number, y: number) => PointXY;
  toCanvasCoords: (x: number, y: number, z?: number) => PointXY;
  /** the world rect the view shows, padded (see visibleBounds) */
  getVisibleBounds: () => BoundingBox;
  start3DTransition: (to3D: boolean) => void;
  getCanvasElement: () => HTMLCanvasElement;
  getCanvasRect: () => DOMRect;
};

export type ViewportRuntime = ViewportApi & {
  destroy: () => void;
};

/**
 * The viewport runtime: the one place that decides who owns the render snapshot and publishes it
 * to the canvas. At any instant exactly one source owns it: the 2D pan/zoom controls, the 3D
 * orbit controls, or the 2D<->3D transition animator. The store's is3DMode/isTransitioning3D
 * describe the DESIRED mode; the `*Active` flags describe which controls are currently WIRED UP.
 * The two intentionally diverge for the length of a transition: while isTransitioning3D is true
 * neither controls source is wanted, and the transition latches on instead. Collapsing these into
 * one "mode" enum would conflate desired vs. wired and lose that lag.
 *
 * `ownedSnapshot` is the snapshot the runtime itself holds (the 3D controls and the transition
 * publish through it; the 2D controls build theirs from their own state and fall back to it). It
 * is an immutable VALUE: only the reference is ever reassigned, always to a freshly built
 * snapshot, which is what makes publishSnapshot's prev/next diff meaningful.
 *
 * Three snapshots are in play: the owned one (held here), the live one (`liveSnapshot()`: what the
 * view shows now, which is the 2D controls' own while they are wanted) and the published one (what
 * the canvas reads, kept in runtime/snapshot.ts).
 */
export function createViewportRuntime({ viewportBridge }: { viewportBridge: ViewportBridge }): ViewportRuntime {
  let ownedSnapshot: ViewportRenderSnapshot = { ...DEFAULT_VIEWPORT_RENDER_SNAPSHOT };
  let controls2DActive = false;
  let controls3DActive = false;
  let sidebarWidth = 0;
  let rect = viewportBridge.getCanvasRect();
  let controlsBlocked = false;
  // bumped to make the orbit controls re-pose their camera from the config's snapshot
  let controls3DSyncToken = 0;

  const wants2DControls = () => !showsDepth(getState());
  const wants3DControls = () => {
    const state = getState();
    return state.is3DMode && !state.isTransitioning3D;
  };

  const publishSnapshot = (snapshot: ViewportRenderSnapshot) => {
    const previousSnapshot = getViewportRenderSnapshot();
    setViewportRenderSnapshot(snapshot);
    const viewportDirty = getSnapshotViewportDirtyFlags(previousSnapshot, snapshot);
    viewportBridge.invalidate(Object.keys(viewportDirty).length > 0 ? viewportDirty : "frame");
  };

  // ---- the 2D controls ----
  const patch2DControls = (patch: Partial<Controls2DConfig>) => set2DControlsConfig({ ...get2DControlsConfig(), ...patch });
  const get2DControlsSnapshot = () => {
    const config = get2DControlsConfig();
    return buildViewport2DSnapshot(config, rect);
  };
  // the snapshot the view shows right now: the 2D controls' own while they are wanted
  const liveSnapshot = () => (wants2DControls() ? get2DControlsSnapshot() : ownedSnapshot);
  // the 2D controls fall back to the owned snapshot, so every reassignment of it is also published to them
  const setOwnedSnapshot = (snapshot: ViewportRenderSnapshot) => {
    ownedSnapshot = snapshot;
    patch2DControls({ fallbackSnapshot: snapshot });
  };
  const adoptPlanarSnapshot = () => setOwnedSnapshot(get2DControlsSnapshot());
  // a 2D state the controls or a fit produced: adopt it as the owned snapshot and publish it
  const adopt2DState = (state: Viewport2DState) => {
    patch2DControls({ state });
    setOwnedSnapshot(buildViewport2DSnapshot({ state, sidebarWidth, fallbackSnapshot: ownedSnapshot }, rect));
    publishSnapshot(ownedSnapshot);
  };
  const sync2DControls = (enabled: boolean) => patch2DControls({ enabled, blocked: controlsBlocked, fallbackSnapshot: ownedSnapshot });

  // ---- navigation: store.isNavigatingViewport is set while a gesture moves the view and
  // cleared VIEWPORT_NAVIGATION_IDLE_MS after its last frame ----
  const navigationIdle = restartableTimeout();
  // the 2D or the 3D controls own navigation whenever no transition runs
  const controlsOwnNavigation = () => !getState().isTransitioning3D;
  const setNavigating = (active: boolean) => {
    if (getState().isNavigatingViewport !== active) setState({ isNavigatingViewport: active });
  };
  const beginNavigation = () => {
    if (!controlsOwnNavigation()) return;
    navigationIdle.clear();
    setNavigating(true);
  };
  const scheduleNavigationEnd = () => {
    navigationIdle.schedule(() => {
      if (controlsOwnNavigation()) setNavigating(false);
    }, VIEWPORT_NAVIGATION_IDLE_MS);
  };
  const clearActiveNavigation = () => {
    navigationIdle.clear();
    setNavigating(false);
  };
  const onNavigationFrame = () => {
    beginNavigation();
    scheduleNavigationEnd();
  };

  // ---- the 3D controls ----
  const rebuild3DSnapshot = (pose = poseOf(ownedSnapshot)) => {
    ownedSnapshot = buildViewport3DSnapshot(ownedSnapshot, pose, rect);
  };
  const onControls3DChange = (pose: ViewportPerspectivePose) => {
    applyPerspectivePose(pose);
    onNavigationFrame();
  };
  const publish3DControlsConfig = ({ syncFromSnapshot = false }: { syncFromSnapshot?: boolean | undefined } = {}) => {
    if (syncFromSnapshot) controls3DSyncToken += 1;
    set3DControlsConfig({
      enabled: controls3DActive,
      blocked: controlsBlocked,
      maxDistance: getMaxPerspectiveDistance3D(ownedSnapshot, rect),
      syncToken: controls3DSyncToken,
      snapshot: ownedSnapshot,
      onStart: onNavigationFrame,
      onChange: onControls3DChange,
      onEnd: scheduleNavigationEnd,
    });
  };
  const applyPerspectivePose = (pose: ViewportPerspectivePose, options: { syncControls?: boolean } = {}) => {
    const previousScaleFactor = ownedSnapshot.scaleFactor;
    rebuild3DSnapshot(pose);
    if (Math.abs(ownedSnapshot.scaleFactor - previousScaleFactor) > 1e-6) {
      // the objective head keeps a constant screen size, so a zoom redraws it
      viewportBridge.invalidate({ objective: true });
    }
    if (controls3DActive && options.syncControls) publish3DControlsConfig({ syncFromSnapshot: true });
    publishSnapshot(ownedSnapshot);
  };
  // the controls that take the view re-pose their camera from the snapshot they take it with
  const sync3DControls = (enabled: boolean) => {
    controls3DActive = enabled;
    if (enabled) rebuild3DSnapshot();
    publish3DControlsConfig({ syncFromSnapshot: enabled });
  };

  // ---- the transition: owns the snapshot from begin to complete ----
  let transitionRun = 0;
  let transitionProgress = 0;
  let transitionPlan: ViewportTransitionPlan | null = null;

  // Derive the frame at `progress` and adopt it as the owned snapshot. While a to-2D transition
  // runs, the 2D controls' planar state follows the frame so the handoff at completion is seamless.
  const renderTransitionFrame = (plan: ViewportTransitionPlan, progress: number) => {
    const frame = buildViewportTransitionFrame(plan, progress, rect);
    if (plan.direction === "to2d") {
      patch2DControls({ fallbackSnapshot: frame.snapshot, state: buildViewport2DStateFromTransitionFrame(plan, frame, rect, sidebarWidth) });
    }
    ownedSnapshot = frame.snapshot;
    return frame;
  };
  const start3DTransition = (to3D: boolean) => {
    if (getState().isTransitioning3D) return;

    // If the user was actively panning, the navigation-end timeout will fire
    // during the transition when ownership is unclaimed (isTransitioning3D is
    // true) and silently bail out, leaving isNavigatingViewport stuck true.
    // Clear it now, before the transition disables the controls that set it.
    clearActiveNavigation();

    const baseSnapshot = liveSnapshot();
    const viewAngle = controls3DActive ? getViewAngleFromSnapshot3D(baseSnapshot) : getState().viewAngle;
    const startTime = performance.now();

    if (wants2DControls()) {
      adoptPlanarSnapshot();
      sync2DControls(false);
    }
    if (controls3DActive) {
      setState({ viewAngle });
      sync3DControls(false);
    }

    const plan = buildViewportTransitionPlan({ snapshot: baseSnapshot, to3D, viewAngle });
    transitionPlan = plan;
    transitionProgress = 0;
    setState({ isTransitioning3D: true, is3DMode: to3D, viewAngle: { ...plan.startAngles } });
    publishSnapshot(renderTransitionFrame(plan, 0).snapshot);

    transitionRun += 1;
    setTransitionConfig({
      active: true,
      runId: transitionRun,
      startTime,
      duration: plan.duration,
      onFrame: (easedProgress) => {
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
        // Synchronous mode switch: clear the plan before setState so the
        // store subscription sees the transition inactive and activates the
        // 2D/3D controls without an extra RAF delay.
        transitionPlan = null;
        if (completed) setState({ isTransitioning3D: false, viewAngle: { ...completed.endAngles } });
        resetTransitionConfig();
        publishSnapshot(liveSnapshot());
      },
    });
  };

  // ---- layout: the canvas rect changed; re-derive and republish whichever snapshot is live ----
  const refreshCanvasRect = () => {
    rect = viewportBridge.getCanvasRect();
    if (transitionPlan) {
      publishSnapshot(renderTransitionFrame(transitionPlan, transitionProgress).snapshot);
      return;
    }
    if (wants2DControls()) {
      adoptPlanarSnapshot();
    } else if (controls3DActive) {
      rebuild3DSnapshot();
      publish3DControlsConfig();
    }
    publishSnapshot(ownedSnapshot);
  };

  // ---- initial ownership ----
  // the 2D controls' snapshot as-is in 2D mode, or lifted into the stored view
  // angle's perspective when the app starts in (or transitioning to) 3D
  const initialSnapshot = (planar: ViewportRenderSnapshot) => {
    const state = getState();
    if (!showsDepth(state)) return planar;
    return buildViewport3DSnapshot(planar, buildPerspectivePoseFromViewAngle(state.viewAngle, getDefaultPerspectiveDistance3D(planar, rect), planar.target), rect);
  };
  set2DControlsConfig({
    enabled: false,
    blocked: controlsBlocked,
    panEnabled: true,
    sidebarWidth,
    state: deriveViewport2DState(ownedSnapshot, sidebarWidth),
    fallbackSnapshot: ownedSnapshot,
    onStateChange: adopt2DState,
    onNavigationFrame: () => {
      if (wants2DControls()) onNavigationFrame();
    },
  });
  setOwnedSnapshot(initialSnapshot(get2DControlsSnapshot()));
  controls2DActive = wants2DControls();
  sync2DControls(controls2DActive);
  sync3DControls(wants3DControls());
  publishSnapshot(liveSnapshot());

  const subscriptions = new AbortController();
  on(
    ["is3DMode", "isTransitioning3D"],
    () => {
      const next2DActive = wants2DControls();
      const next3DActive = wants3DControls();
      const changed3D = next3DActive !== controls3DActive;
      if (next2DActive === controls2DActive && !changed3D) return;

      sync2DControls(next2DActive);
      if (changed3D) sync3DControls(next3DActive);
      controls2DActive = next2DActive;

      // the transition owns the snapshot until it completes; don't let a mode
      // change mid-transition publish a competing controls snapshot
      if (transitionPlan) return;
      if (controls2DActive) {
        adoptPlanarSnapshot();
        sync2DControls(true);
      }
      publishSnapshot(ownedSnapshot);
    },
    subscriptions.signal,
  );
  onViewportDirty((viewportDirty) => viewportBridge.invalidate(viewportDirty), subscriptions.signal);
  // the sketch cursor moves the rubber band while a region is being drawn
  subscribeCurrentMouse(() => {
    const state = getState();
    if (state.completionMode === "draft" && state.vertices.length > 0) viewportBridge.invalidate({ polytope: true });
  }, subscriptions.signal);

  return {
    setSidebarWidth: (width) => {
      sidebarWidth = width;
      patch2DControls({ sidebarWidth: width });
      refreshCanvasRect();
    },
    zoomToFit: (bounds, zBounds, topInset) => {
      if (wants2DControls()) {
        adopt2DState(fitViewport2DToBounds(get2DControlsConfig(), rect, bounds, { topInset }));
        return;
      }
      const state = getState();
      if (state.isTransitioning3D) return;
      const scaledZ = zBounds ? { minZ: (zBounds.minZ * state.zScale) / 100, maxZ: (zBounds.maxZ * state.zScale) / 100 } : undefined;
      applyPerspectivePose(fitViewport3DToBounds(ownedSnapshot, rect, bounds, { sidebarWidth, zBounds: scaledZ, topInset }).pose, { syncControls: true });
    },
    resetView: () => {
      setState({ viewAngle: { ...DEFAULT_VIEW_ANGLE } });
      if (wants2DControls()) {
        adopt2DState({ gridSpacing: get2DControlsConfig().state.gridSpacing, scaleFactor: 1, offsetX: 0, offsetY: 0 });
        return;
      }
      if (getState().isTransitioning3D) return;
      applyPerspectivePose(buildResetViewport3DView(ownedSnapshot, sidebarWidth, rect).pose, { syncControls: true });
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
      if (wants2DControls()) return toLogicalCoords2D(get2DControlsSnapshot(), rect, point, { snapToGrid: state.snapToGrid });
      const { editorInteraction } = state;
      const viewAnchor3D = editorInteraction.kind === "dragging" ? editorInteraction.target.viewAnchor3D : undefined;
      return toLogicalCoords3D(ownedSnapshot, rect, point, { zScale: state.zScale, snapToGrid: state.snapToGrid, interacting: editorInteraction.kind !== "idle", viewAnchor3D });
    },
    toCanvasCoords: (x, y, z) => (wants2DControls() ? toCanvasCoords2D(get2DControlsSnapshot(), rect, { x, y }) : toCanvasCoords3D(ownedSnapshot, rect, { x, y }, z, getState().zScale)),
    getVisibleBounds: () => visibleBounds(liveSnapshot()),
    start3DTransition,
    getCanvasElement: () => viewportBridge.getCanvasElement(),
    getCanvasRect: () => rect,
    destroy: () => {
      clearActiveNavigation();
      transitionPlan = null;
      resetTransitionConfig();
      reset2DControlsConfig();
      reset3DControlsConfig();
      subscriptions.abort();
      resetViewportRenderSnapshot();
    },
  };
}
