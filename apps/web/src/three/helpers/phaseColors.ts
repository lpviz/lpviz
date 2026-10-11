import { Color } from "three";

const PHASE_COLORS = ["#377eb8", "#800080", "#4daf4a", "#984ea3", "#ff7f00", "#ffff33", "#a65628", "#f781bf", "#999999", "#17becf"];

// linear working-space RGB per phase, as the point attributes and the ribbons' color textures want it
const PHASE_COLORS_LINEAR: ReadonlyArray<readonly [number, number, number]> = PHASE_COLORS.map((hex) => {
  const c = new Color(hex);
  return [c.r, c.g, c.b] as const;
});

/**
 * The phases when they label every one of the `count` iterates drawn, else null: a run without
 * phases has none, and a replay slices them to the path's count (see replayController), which is
 * one more than the dot cloud draws.
 */
export const phasesCovering = (phases: number[], count: number): number[] | null => (count > 0 && phases.length >= count ? phases : null);

// Per-point linear RGB for `count` iterates: iterate i, or iterate indices[i]
// when a subset of the path is drawn.
export function writePhaseColors(out: Float32Array, phases: number[], indices: number[] | null, count: number): void {
  for (let i = 0; i < count; i++) {
    const rgb = PHASE_COLORS_LINEAR[phases[indices ? indices[i]! : i]! % PHASE_COLORS_LINEAR.length]!;
    out[i * 3] = rgb[0];
    out[i * 3 + 1] = rgb[1];
    out[i * 3 + 2] = rgb[2];
  }
}

// a shared grow-only scratch for a whole path's colors (valid until the next call; the caller
// uploads it synchronously)
let scratch = new Float32Array(0);

/** Per-point linear RGB for every iterate of a path. */
export function phaseColorsOf(phases: number[]): Float32Array {
  if (scratch.length < phases.length * 3) scratch = new Float32Array(phases.length * 3);
  writePhaseColors(scratch, phases, null, phases.length);
  return scratch;
}
