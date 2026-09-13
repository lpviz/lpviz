import { getState, setState } from "@/features/core/store";
import { beginSphereSpiral, computeObjectiveRotationStep, sphereSpiralObjective, type SphereSpiralState } from "@lpviz/polytope/objectiveDirection";

const BASE_ROTATION_WAIT_MS = 30;

export type RotationController = {
  // start rotating from the current objective (resets direction + timing)
  begin: () => void;
  // stop the loop and drop any in-flight solve's re-arm (see the session guard)
  cancel: () => void;
  // clear the frame-pacing accumulator without restarting the loop
  resetTiming: () => void;
  // resume the RAF loop if rotation is still active (e.g. after a problem edit)
  rearm: () => void;
};

// Owns the objective-rotation loop: a frame-paced RAF driver that, while
// `rotateObjectiveMode` is set, steps the objective by one angle increment and
// re-solves — at most one solve in flight at a time. Extracted from
// solverActions so the loop's timing + single-flight + cancellation logic lives
// in one testable place instead of six module-scoped variables.
export function createRotationController(deps: { computePath: () => Promise<void>; syncTraceCapacity: () => void; hasCanvas: () => boolean }): RotationController {
  let rafId: number | null = null;
  let lastFrameTime: number | null = null;
  let elapsedMs = 0;
  let inFlight = false;
  // bumped by cancel() so a solve started in an earlier rotation session can't
  // clear the in-flight flag or re-arm the loop of the current one from its
  // finally block (which would let the loop start overlapping solves)
  let session = 0;
  let direction: 1 | -1 = 1;
  // 3D sweep state: anchored at the objective when rotation begins, then
  // advanced by angleStep radians of azimuth per solve (see sphereSpiralObjective)
  let spiral: SphereSpiralState | null = null;
  let spiralT = 0;

  const ensureLoop = () => {
    if (!getState().rotateObjectiveMode || rafId !== null) return;
    const tick = (timestamp: number) => {
      rafId = null;
      if (!getState().rotateObjectiveMode) return;
      if (lastFrameTime === null) lastFrameTime = timestamp;
      else {
        elapsedMs += timestamp - lastFrameTime;
        lastFrameTime = timestamp;
      }
      const intervalMs = Math.max(1, BASE_ROTATION_WAIT_MS / Math.max(0.1, getState().solverSettings.objectiveRotationSpeed || 1));
      if (!inFlight && elapsedMs >= intervalMs) {
        elapsedMs = 0;
        void step();
      }
      if (getState().rotateObjectiveMode) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  };

  const step = async () => {
    if (!deps.hasCanvas()) return;
    const state = getState();
    if (!state.rotateObjectiveMode || inFlight) return;
    inFlight = true;
    const mySession = session;
    const angleStep = Math.max(0.001, state.solverSettings.objectiveAngleStep || 0.001);
    if (state.problemMode === "3d") {
      spiral ??= beginSphereSpiral(state.objectiveVector3 ?? { x: 1, y: 0, z: 1 });
      spiralT += angleStep;
      setState({
        objectiveVector3: sphereSpiralObjective(spiral, spiralT),
        highlightIteratePathIndex: null,
      });
    } else {
      const rotationStep = computeObjectiveRotationStep({
        objectiveVector: state.objectiveVector ?? { x: 1, y: 0 },
        angleStep,
        rotationDirection: direction,
        polytope: state.polytope,
      });
      direction = rotationStep.nextDirection;
      setState({
        objectiveVector: rotationStep.nextObjective,
        highlightIteratePathIndex: null,
      });
    }
    if (getState().traceEnabled) deps.syncTraceCapacity();
    try {
      await deps.computePath();
    } finally {
      if (mySession === session) {
        inFlight = false;
        if (getState().rotateObjectiveMode) ensureLoop();
      }
    }
  };

  return {
    begin: () => {
      direction = 1;
      spiral = null;
      spiralT = 0;
      lastFrameTime = null;
      elapsedMs = 0;
      void step();
    },
    cancel: () => {
      session++;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      lastFrameTime = null;
      elapsedMs = 0;
      inFlight = false;
    },
    resetTiming: () => {
      lastFrameTime = null;
      elapsedMs = 0;
    },
    rearm: () => ensureLoop(),
  };
}
