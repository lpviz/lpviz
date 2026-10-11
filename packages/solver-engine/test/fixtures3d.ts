// Three-variable regions as half-spaces [a1, a2, a3, b] (a'x <= b), and the brute force to check
// a solver's answer against their vertices.

import { solveDenseSystem } from "@lpviz/math/lapack";
import type { Constraint, Vec } from "@lpviz/math/types";

// cube centered at the origin: |x| <= 4, |y| <= 4, |z| <= 4
export const CUBE: Constraint[] = [
  [1, 0, 0, 4],
  [-1, 0, 0, 4],
  [0, 1, 0, 4],
  [0, -1, 0, 4],
  [0, 0, 1, 4],
  [0, 0, -1, 4],
];

// asymmetric box: x in [-2, 1], y in [-3, 2], z in [-4, 3]
export const BOX: Constraint[] = [
  [1, 0, 0, 1],
  [-1, 0, 0, 2],
  [0, 1, 0, 2],
  [0, -1, 0, 3],
  [0, 0, 1, 3],
  [0, 0, -1, 4],
];

// the box with its (1, 2, 3) corner sliced off, so a random objective can land
// on a non-axis-aligned facet
export const SLICED_BOX: Constraint[] = [...BOX, [1, 1, 1, 4]];

export const satisfiesAll = (planes: Constraint[], p: ArrayLike<number>) => planes.every((q) => q[0] * p[0]! + q[1] * p[1]! + q[2] * p[2]! <= q[3]! + 1e-6);

// Brute-force vertex enumeration: every feasible intersection of three planes.
export function verticesOf(planes: Constraint[]): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i < planes.length; i++)
    for (let j = i + 1; j < planes.length; j++)
      for (let k = j + 1; k < planes.length; k++) {
        const rows = [planes[i]!, planes[j]!, planes[k]!];
        let p: Vec;
        try {
          p = Array.from(
            solveDenseSystem(
              Float64Array.from(rows.flatMap((row) => row.slice(0, 3))),
              3,
              Float64Array.from(rows, (row) => row[3]!),
              new Float64Array(3),
            ),
          ) as Vec;
        } catch {
          continue; // the planes do not meet in a point
        }
        if (satisfiesAll(planes, p) && !out.some((v) => Math.hypot(v[0] - p[0], v[1] - p[1], v[2]! - p[2]!) < 1e-7)) out.push(p);
      }
  return out;
}
