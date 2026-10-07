import type { Vec } from "./types";

/** The origin of a problem space with `dimension` variables. */
export function zeroVec(dimension: number): Vec {
  return Array.from({ length: dimension }, () => 0) as Vec;
}

/** Euclidean distance between two points of the same dimension. */
export function vecDistance(a: Vec, b: Vec): number {
  return Math.hypot(...a.map((value, j) => value - (b[j] ?? 0)));
}
