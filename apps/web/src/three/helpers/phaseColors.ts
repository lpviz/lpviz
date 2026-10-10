import { Color } from "three";

const PHASE_COLORS = ["#377eb8", "#800080", "#4daf4a", "#984ea3", "#ff7f00", "#ffff33", "#a65628", "#f781bf", "#999999", "#17becf"];

const PHASE_COLORS_LINEAR: ReadonlyArray<readonly [number, number, number]> = PHASE_COLORS.map((hex) => {
  const c = new Color(hex);
  return [c.r, c.g, c.b] as const;
});

// linear working-space bytes for per-point color textures (see pathRibbon.ts)
const PHASE_COLORS_BYTES: ReadonlyArray<readonly [number, number, number]> = PHASE_COLORS_LINEAR.map(([r, g, b]) => [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)] as const);

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

// Per-point RGBA bytes for a ribbon's color texture, in a shared grow-only
// scratch (valid until the next call; the caller uploads it synchronously).
let byteScratch = new Uint8Array(0);

export function phaseColorBytes(phases: number[]): Uint8Array {
  if (byteScratch.length < phases.length * 4) byteScratch = new Uint8Array(phases.length * 4);
  for (let i = 0; i < phases.length; i++) {
    const rgb = PHASE_COLORS_BYTES[phases[i]! % PHASE_COLORS_BYTES.length]!;
    const base = i * 4;
    byteScratch[base] = rgb[0];
    byteScratch[base + 1] = rgb[1];
    byteScratch[base + 2] = rgb[2];
    byteScratch[base + 3] = 255;
  }
  return byteScratch;
}
