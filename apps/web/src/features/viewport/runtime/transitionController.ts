import { getState, setState } from "@/features/core/store";
import {
  buildTransitionCompleteState,
  buildTransitionStartState,
  buildViewport2DStateFromTransitionFrame,
  buildViewportTransitionFrame,
  buildViewportTransitionPlan,
  TRANSITION_VIEWPORT_DIRTY_FLAGS,
  type ViewportTransitionPlan,
} from "@lpviz/viewport/transition";
import { getViewAngleFromSnapshot3D } from "@lpviz/viewport/view3d";
import type { ViewportRenderSnapshot } from "../types";
import { setViewport2DControlsConfig, setViewport2DControlsState } from "./controls2d";
import { resetViewportTransitionConfig, setViewportTransitionConfig } from "./transitionConfig";

export type TransitionController = {
  // animate the 2D<->3D mode switch toward targetMode (true = 3D)
  begin: (targetMode: boolean) => void;
  // true while the animator owns the render snapshot — the ownership latch the
  // store subscription checks so it doesn't activate a competing controls source
  isActive: () => boolean;
  // re-derive + republish the current frame at its current progress (e.g. a
  // layout change mid-transition); no-op when no transition is running
  republishCurrentFrame: () => void;
  // abandon any in-flight transition without completing it (teardown)
  reset: () => void;
};

// Owns the 2D<->3D transition animation: the run/latch/progress/plan state and
// the start -> per-frame -> complete lifecycle. Extracted from the runtime so
// the animator — one of the three snapshot-ownership sources — lives in one
// place behind a small interface, mirroring the rotation/result controllers.
//
// The animator co-owns `managerSnapshot` with the runtime (it publishes through
// it during the animation, then hands back to the 2D/3D controls on complete),
// so that one snapshot is threaded in as get/set rather than duplicated.
export function createTransitionController(deps: {
  getManagerSnapshot: () => ViewportRenderSnapshot;
  setManagerSnapshot: (snapshot: ViewportRenderSnapshot) => void;
  getViewportRect: () => DOMRect;
  getSidebarWidth: () => number;
  shouldUseExternal2DViewport: () => boolean;
  isExternal3DControlsActive: () => boolean;
  getExternal2DSnapshot: () => ViewportRenderSnapshot;
  publishSnapshot: (snapshot: ViewportRenderSnapshot) => void;
  syncManagerPlanarState: () => void;
  syncExternal2DControls: (enabled: boolean) => void;
  syncExternal3DControls: (enabled: boolean) => void;
  clearActiveNavigation: () => void;
}): TransitionController {
  let runId = 0;
  let snapshotActive = false;
  let progress = 0;
  let plan: ViewportTransitionPlan | null = null;

  // While a to-2D transition runs, keep the 2D controls' planar state in lockstep
  // with the animated frame so the handoff at completion is seamless. (to-3D
  // transitions have no planar control state to track.)
  const syncPlanarState = (p: ViewportTransitionPlan, frame: ReturnType<typeof buildViewportTransitionFrame>) => {
    if (p.direction !== "to2d") return;
    const planarState = buildViewport2DStateFromTransitionFrame(p, frame, deps.getViewportRect(), deps.getSidebarWidth());
    setViewport2DControlsConfig(
      {
        sidebarWidth: deps.getSidebarWidth(),
        fallbackSnapshot: frame.snapshot,
      },
      { emit: false },
    );
    setViewport2DControlsState(planarState, { notify: false, emit: false });
  };

  // derive the frame at progress `at`, keep planar state in lockstep, and adopt
  // it as the manager snapshot
  const renderFrameAt = (p: ViewportTransitionPlan, at: number) => {
    const frame = buildViewportTransitionFrame(p, at, deps.getViewportRect());
    syncPlanarState(p, frame);
    deps.setManagerSnapshot(frame.snapshot);
    return frame;
  };

  return {
    isActive: () => snapshotActive,

    republishCurrentFrame: () => {
      if (!snapshotActive || !plan) return;
      const frame = renderFrameAt(plan, progress);
      deps.publishSnapshot(frame.snapshot);
    },

    reset: () => {
      snapshotActive = false;
      plan = null;
      resetViewportTransitionConfig();
    },

    begin: (targetMode) => {
      if (getState().isTransitioning3D) return;

      // If the user was actively panning, the navigation-end timeout will fire
      // during the transition when ownership is unclaimed (isTransitioning3D is
      // true) and silently bail out, leaving isNavigatingViewport stuck true.
      // Clear it now, before the transition disables the controls that set it.
      deps.clearActiveNavigation();

      const baseSnapshot = deps.shouldUseExternal2DViewport() ? deps.getExternal2DSnapshot() : deps.getManagerSnapshot();
      const viewAngle = deps.isExternal3DControlsActive() ? getViewAngleFromSnapshot3D(baseSnapshot) : getState().viewAngle;
      const startTime = performance.now();

      if (deps.shouldUseExternal2DViewport()) {
        deps.syncManagerPlanarState();
        deps.syncExternal2DControls(false);
      }
      if (deps.isExternal3DControlsActive()) {
        setState({ viewAngle }, { viewportDirty: {} });
        deps.syncExternal3DControls(false);
      }

      const nextPlan = buildViewportTransitionPlan({
        snapshot: baseSnapshot,
        targetMode,
        viewAngle,
      });

      snapshotActive = true;
      plan = nextPlan;
      progress = 0;
      setState(buildTransitionStartState(targetMode, startTime, nextPlan), {
        viewportDirty: TRANSITION_VIEWPORT_DIRTY_FLAGS,
      });
      const initialFrame = renderFrameAt(nextPlan, 0);
      deps.publishSnapshot(initialFrame.snapshot);

      runId += 1;
      setViewportTransitionConfig({
        active: true,
        runId,
        targetMode,
        startTime,
        duration: nextPlan.duration,
        onFrame: (_progress, easedProgress) => {
          if (!plan) return;
          progress = easedProgress;
          const frame = renderFrameAt(plan, easedProgress);
          deps.publishSnapshot(frame.snapshot);
        },
        onComplete: () => {
          const completedPlan = plan;
          if (completedPlan) {
            progress = 1;
            renderFrameAt(completedPlan, 1);
          }
          // Synchronous mode switch: clear the latch before setState so the
          // store subscription sees the transition inactive and activates the
          // 2D/3D controls without an extra RAF delay.
          snapshotActive = false;
          plan = null;
          if (completedPlan) {
            setState(buildTransitionCompleteState(completedPlan), {
              viewportDirty: TRANSITION_VIEWPORT_DIRTY_FLAGS,
            });
          }
          resetViewportTransitionConfig();
          deps.publishSnapshot(deps.shouldUseExternal2DViewport() ? deps.getExternal2DSnapshot() : deps.getManagerSnapshot());
        },
      });
    },
  };
}
