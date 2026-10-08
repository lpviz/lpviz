// Three-variable regions as half-spaces [a1, a2, a3, b] (a'x <= b), and the brute force to check
// a solver's answer against their vertices.

import { expect } from "bun:test";
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

const det3 = (a: ArrayLike<number>, b: ArrayLike<number>, c: ArrayLike<number>) =>
  a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!);

// Brute-force vertex enumeration: every feasible intersection of three planes.
export function verticesOf(planes: Constraint[]): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i < planes.length; i++)
    for (let j = i + 1; j < planes.length; j++)
      for (let k = j + 1; k < planes.length; k++) {
        const rows = [planes[i]!, planes[j]!, planes[k]!];
        const det = det3(rows[0]!, rows[1]!, rows[2]!);
        if (Math.abs(det) < 1e-9) continue;
        // Cramer's rule: replace column m by the right-hand sides
        const col = (m: number) => {
          const replaced = rows.map((row) => {
            const copy = row.slice(0, 3);
            copy[m] = row[3]!;
            return copy;
          });
          return det3(replaced[0]!, replaced[1]!, replaced[2]!);
        };
        const p: Vec = [col(0) / det, col(1) / det, col(2) / det];
        if (satisfiesAll(planes, p) && !out.some((v) => Math.hypot(v[0] - p[0], v[1] - p[1], v[2]! - p[2]!) < 1e-7)) out.push(p);
      }
  return out;
}

export const expectNear = (point: ArrayLike<number>, expected: readonly number[], digits: number) => {
  expect(point.length).toBe(expected.length);
  expected.forEach((value, j) => expect(point[j]!).toBeCloseTo(value, digits));
};
