import type { Vec } from "./types";

/** The origin of a problem space with `dimension` variables. */
export function zeroVec(dimension: number): Vec {
  return Array.from({ length: dimension }, () => 0) as Vec;
}
