import { getState, setState } from "@/features/core/store";
import type { Vec } from "@lpviz/math/types";
import { isObjectiveDirectionUnbounded } from "@lpviz/polytope/halfSpaces";
import { hasConstraints, type Polytope } from "@lpviz/polytope/polytope";

const BASE_ROTATION_WAIT_MS = 30;

type RotationDirection = 1 | -1;

// The objective turned by one step. Over an unbounded region the step reverses rather than point
// the objective into an unbounded direction; when both ways do, it keeps turning so the loop
// never stalls (the solver reports the unboundedness for those frames).
function rotateObjective(objectiveVector: Vec, angleStep: number, direction: RotationDirection, polytope: Polytope | null): { next: Vec; direction: RotationDirection } {
  const angle = Math.atan2(objectiveVector[1], objectiveVector[0]);
  const magnitude = Math.hypot(objectiveVector[0], objectiveVector[1]);
  const turned = (way: RotationDirection): Vec => [magnitude * Math.cos(angle + angleStep * way), magnitude * Math.sin(angle + angleStep * way)];

  let nextDirection = direction;
  if (hasConstraints(polytope) && polytope.kind === "unbounded") {
    const allowed = ([direction, direction === 1 ? -1 : 1] as const).find((way) => !isObjectiveDirectionUnbounded(polytope.constraints, turned(way)));
    if (allowed !== undefined) nextDirection = allowed;
  }
  return { next: turned(nextDirection), direction: nextDirection };
}

// the per-step rotation angle, never zero (a zero step would rotate forever)
export const objectiveAngleStep = (settings: { objectiveAngleStep: number }) => Math.max(0.001, settings.objectiveAngleStep || 0.001);

export type RotationController = {
  // start rotating from the current objective (resets direction + timing)
  begin: () => void;
  // stop the loop and drop any in-flight solve's re-arm (see the session guard)
  cancel: () => void;
  // resume the RAF loop if rotation is still active (e.g. after a problem edit)
  rearm: () => void;
};

// The objective-rotation loop: a frame-paced RAF driver that, while `rotateObjectiveMode` is
// set, steps the objective by one angle increment and re-solves, with at most one solve in
// flight at a time.
export function createRotationController({ solve, syncTraceCapacity }: { solve: () => Promise<void>; syncTraceCapacity: () => void }): RotationController {
  let rafId: number | null = null;
  let lastFrameTime: number | null = null;
  let elapsedMs = 0;
  let inFlight = false;
  // bumped by cancel() so a solve started in an earlier rotation session can't
  // clear the in-flight flag or re-arm the loop of the current one from its
  // finally block (which would let the loop start overlapping solves)
  let session = 0;
  let direction: RotationDirection = 1;

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
    const state = getState();
    if (!state.rotateObjectiveMode || inFlight || !state.objectiveVector) return;
    inFlight = true;
    const mySession = session;
    const turned = rotateObjective(state.objectiveVector, objectiveAngleStep(state.solverSettings), direction, state.polytope);
    direction = turned.direction;
    setState({
      objectiveVector: turned.next,
      highlightIteratePathIndex: null,
    });
    if (getState().traceEnabled) syncTraceCapacity();
    try {
      await solve();
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
    rearm: () => ensureLoop(),
  };
}
