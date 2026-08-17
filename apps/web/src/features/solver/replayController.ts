import { getState, setState } from "@/features/core/store";
import { clampReplayDurationMs } from "@/features/solver/replayDuration";
import type { ViewportApi } from "@/features/viewport/runtime";

export type ReplayController = {
  // start a replay, or stop the one already playing — the Animate button is
  // the same control for both
  toggle: () => void;
  // stop any replay and put the fully solved path back on screen
  cancel: () => void;
};

// Owns the "Animate" replay: a RAF driver that maps elapsed wall-clock time
// onto the iterate polyline, so a replay takes the configured duration whether
// the solve produced 20 iterates or 20,000. A per-step timer cannot do that —
// at maxit the path holds 100k iterates, and one tick per iterate inside a
// second is not something the event loop can deliver — so each frame computes
// the head's fractional position straight from the clock, crossing however many
// iterates that takes.
export function createReplayController(deps: {
  getCanvasManager: () => ViewportApi | null;
  // the user hovering a log row owns the highlight; the replay yields it
  isIterateHoverActive: () => boolean;
}): ReplayController {
  let rafId: number | null = null;

  const cancel = () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    const state = getState();
    if (!state.replayActive) return;
    // Stopping mid-sweep must leave exactly the picture a completed replay
    // leaves: the whole path back on screen (which also releases the scratch
    // buffer) and the optimum star visible again. Freezing the partial sweep
    // would strand the user with a truncated path and no way back short of
    // re-solving.
    setState({
      iteratePath: state.originalIteratePath,
      iteratePhases: state.originalIteratePhases,
      replayActive: false,
      ...(deps.isIterateHoverActive()
        ? {}
        : { highlightIteratePathIndex: null }),
    });
    deps.getCanvasManager()?.draw();
  };

  const start = () => {
    const cm = deps.getCanvasManager();
    if (!cm) return;
    const snap = getState();
    if (snap.rotateObjectiveMode) return;
    const orig = snap.originalIteratePath;
    const total = orig.count;
    const stride = orig.stride;
    if (total === 0) return;
    const origPhases = snap.originalIteratePhases;
    const durationMs = clampReplayDurationMs(snap.solverSettings.replaySpeed);

    // One copy of the path per replay, never per frame. The sweep only ever
    // rewrites the `stride` floats of the moving head, so every point behind it
    // is still the solver's own data — which is what lets a 100k-iterate path
    // animate without allocating anything per frame.
    const points = orig.points.slice(0, total * stride);
    // which slot currently holds the interpolated head rather than its real
    // iterate, so it can be put back once the head has moved past it
    let headIndex = -1;
    let shownCount = 0;

    setState({
      iteratePath: { points, count: 0, stride },
      iteratePhases: [],
      iterateObjectiveVector: snap.originalIterateObjectiveVector,
      highlightIteratePathIndex: null,
      replayActive: true,
    });
    cm.draw();

    const startTime = performance.now();
    const tick = (timestamp: number) => {
      rafId = null;
      // whoever stopped the replay cleared the flag; a frame that was already
      // queued must not keep mutating the store or drawing after that
      if (!getState().replayActive) return;
      const canvas = deps.getCanvasManager();
      if (!canvas) {
        cancel();
        return;
      }
      const progress = (timestamp - startTime) / durationMs;
      // cancel() restores the untouched original path, so the run ends exactly
      // on the last iterate rather than a rounded approximation of it
      if (progress >= 1 || total < 2) {
        cancel();
        return;
      }
      // the head's fractional position along the polyline: `base` whole
      // iterates plus `t` of the way into the segment leaving it
      const position = progress * (total - 1);
      const base = Math.floor(position);
      const t = position - base;
      const head = base + 1;
      const count = head + 1;

      if (headIndex >= 0 && headIndex !== head) {
        // the head has moved on, so that slot is a real iterate again
        const from = headIndex * stride;
        for (let k = 0; k < stride; k++) {
          points[from + k] = orig.points[from + k]!;
        }
      }
      const fromBase = base * stride;
      const headBase = head * stride;
      // every component interpolates, the baked z included — leaving it at the
      // segment's end value would drag the head along the floor in 3D while the
      // rest of the path is lifted
      for (let k = 0; k < stride; k++) {
        const a = orig.points[fromBase + k]!;
        points[headBase + k] = a + t * (orig.points[headBase + k]! - a);
      }
      headIndex = head;

      setState({
        iteratePath: { points, count, stride },
        // the phase array has to be exactly `count` long or IterateLineLayer
        // drops phase colouring; it only changes when the head crosses an
        // iterate, so most frames skip the slice
        ...(origPhases.length > 0 && count !== shownCount
          ? { iteratePhases: origPhases.slice(0, count) }
          : {}),
        // The index tracks the last *whole* iterate the head has passed, for
        // everything that needs a real one (EllipsoidLayer reveals that
        // iterate's localizing ellipse). The green marker does not read it —
        // it rides the interpolated head instead, so it sweeps rather than
        // snapping — see IterateHighlightLayer.
        ...(deps.isIterateHoverActive()
          ? {}
          : { highlightIteratePathIndex: base }),
      });
      shownCount = count;
      canvas.draw();
      // a listener of the patch above may have cancelled us mid-frame
      if (getState().replayActive) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  };

  return {
    toggle: () => {
      if (getState().replayActive) cancel();
      else start();
    },
    cancel,
  };
}
