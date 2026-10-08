import type { Vec } from "./types";

// How many decision variables a problem can have: the length of every Vec it holds.
const DIMENSIONS = [2, 3] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export const isDimension = (value: unknown): value is Dimension => (DIMENSIONS as readonly unknown[]).includes(value);

const VARIABLE_NAMES = ["x", "y", "z"];

/** The name of variable `index` as the logs and the problem panel print it. */
export const variableName = (index: number): string => VARIABLE_NAMES[index] ?? `x${index + 1}`;

/** A Vec from any list of at least two coordinates. */
export function vecFrom(values: ArrayLike<number>): Vec {
  if (values.length < 2) throw new Error(`A point needs at least two coordinates, got ${values.length}`);
  return Array.from(values) as Vec;
}

/** The origin of a problem space with `dimension` variables. */
export function zeroVec(dimension: number): Vec {
  return Array.from({ length: dimension }, () => 0) as Vec;
}

/** Euclidean distance between two points of the same dimension. */
export function vecDistance(a: Vec, b: Vec): number {
  return Math.hypot(...a.map((value, j) => value - (b[j] ?? 0)));
}

/** The per-axis minimum and maximum over `points` (the points' own dimension). */
export function boundsOf(points: readonly Vec[]): { min: number[]; max: number[] } {
  const dimension = points[0]?.length ?? 0;
  const min = new Array<number>(dimension).fill(Infinity);
  const max = new Array<number>(dimension).fill(-Infinity);
  for (const point of points) {
    for (let j = 0; j < dimension; j++) {
      const value = point[j]!;
      if (value < min[j]!) min[j] = value;
      if (value > max[j]!) max[j] = value;
    }
  }
  return { min, max };
}
