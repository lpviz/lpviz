// The rungs the +/- shortcuts step through, in milliseconds. A ladder rather
// than a continuous multiplier so every value the user can land on reads
// cleanly ("0.25s", not "0.264s") and both ends are exactly reachable. The
// spacing is a 1-1.5-2.5-4-6 series (~1.6x per press), which puts the 0.1s and
// 10s ends five presses away from the 1s default.
const REPLAY_DURATIONS_MS = [
  100, 150, 250, 400, 600, 1000, 1500, 2500, 4000, 6000, 10000,
] as const;

export const DEFAULT_REPLAY_DURATION_MS = 1000;
const MIN_REPLAY_DURATION_MS = REPLAY_DURATIONS_MS[0];
const MAX_REPLAY_DURATION_MS =
  REPLAY_DURATIONS_MS[REPLAY_DURATIONS_MS.length - 1]!;

export function clampReplayDurationMs(durationMs: number): number {
  if (!Number.isFinite(durationMs)) return DEFAULT_REPLAY_DURATION_MS;
  return Math.min(
    MAX_REPLAY_DURATION_MS,
    Math.max(MIN_REPLAY_DURATION_MS, durationMs),
  );
}

// Move one rung. A value that is not itself a rung (an out-of-range stored
// setting, or the hidden speed slider's old 1..100 range) snaps to the nearest
// rung first, so the first press always lands on the ladder instead of
// drifting alongside it.
export function stepReplayDurationMs(
  durationMs: number,
  direction: 1 | -1,
): number {
  const current = clampReplayDurationMs(durationMs);
  let nearest = 0;
  for (let i = 1; i < REPLAY_DURATIONS_MS.length; i++) {
    if (
      Math.abs(REPLAY_DURATIONS_MS[i]! - current) <
      Math.abs(REPLAY_DURATIONS_MS[nearest]! - current)
    ) {
      nearest = i;
    }
  }
  const next =
    REPLAY_DURATIONS_MS[nearest] === current ? nearest + direction : nearest;
  return REPLAY_DURATIONS_MS[
    Math.min(REPLAY_DURATIONS_MS.length - 1, Math.max(0, next))
  ]!;
}

export function formatReplayDuration(durationMs: number): string {
  const seconds = durationMs / 1000;
  // sub-second rungs need two decimals to tell 0.15 from 0.1; a whole second
  // reads better as "1.0s" than "1s", so keep exactly one decimal above that
  const text =
    seconds < 1 ? seconds.toFixed(2).replace(/0$/, "") : seconds.toFixed(1);
  return `${text}s`;
}
