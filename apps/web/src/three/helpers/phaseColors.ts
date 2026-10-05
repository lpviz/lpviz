import { Color } from "three";

const PHASE_COLORS = ["#377eb8", "#800080", "#4daf4a", "#984ea3", "#ff7f00", "#ffff33", "#a65628", "#f781bf", "#999999", "#17becf"];

export const PHASE_COLORS_LINEAR: ReadonlyArray<readonly [number, number, number]> = PHASE_COLORS.map((hex) => {
  const c = new Color(hex);
  return [c.r, c.g, c.b] as const;
});

// linear working-space bytes for per-point color textures (see pathRibbon.ts)
export const PHASE_COLORS_BYTES: ReadonlyArray<readonly [number, number, number]> = PHASE_COLORS_LINEAR.map(([r, g, b]) => [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)] as const);
