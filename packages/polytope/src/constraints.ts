import { centroid, turn } from "@lpviz/math/polygon";
import type { Constraint, Vec } from "@lpviz/math/types";
import { variableName } from "@lpviz/math/vec";

function roundCoefficient(value: number): number {
  return value === Math.floor(value) ? value : parseFloat(value.toFixed(3));
}

/** The constraint as the problem panel prints it: "x + 2y ≤ 3", "-x ≤ 0", "0 ≤ 1". */
export function formatConstraint(constraint: Constraint): string {
  const n = constraint.length - 1;
  const bound = roundCoefficient(constraint[n]!);
  let terms = "";
  for (let j = 0; j < n; j++) {
    const coefficient = roundCoefficient(constraint[j]!);
    if (coefficient === 0) continue;
    const magnitude = Math.abs(coefficient) === 1 ? variableName(j) : `${Math.abs(coefficient)}${variableName(j)}`;
    if (terms === "") terms = coefficient < 0 ? `-${magnitude}` : magnitude;
    else terms += coefficient < 0 ? ` - ${magnitude}` : ` + ${magnitude}`;
  }
  return terms === "" ? `0 ≤ ${bound}` : `${terms} ≤ ${bound}`;
}

// Which way an open chain turns, as -1 (right), +1 (left) or 0 (collinear, or turning both
// ways). The natural normal (A = dy, B = -dx) puts the interior on the <= side of a left-turning
// chain. A turn counts when the sine of its angle exceeds `tol`: the raw cross product has units
// of length squared and would call every turn of a small chain collinear. The turn is a local
// property, so unlike the centroid rule no single distant vertex can swing an edge outward.
function chainTurnSign(points: readonly Vec[], tol: number): -1 | 0 | 1 {
  let sign: number = 0;
  for (let i = 0; i + 2 < points.length; i++) {
    const { cross, lengths } = turn(points[i]!, points[i + 1]!, points[i + 2]!);
    if (Math.abs(cross) <= tol * lengths) {
      continue;
    }
    const next = Math.sign(cross);
    if (sign === 0) sign = next;
    else if (next !== sign) return 0;
  }
  return sign as -1 | 0 | 1;
}

/**
 * The constraints whose boundaries are the chain's edges, with unit normals pointing out of the
 * region: every edge of a closed polygon, or every edge of an open chain (whose ends continue as
 * rays). An edge of zero length yields no constraint.
 */
export function constraintsFromChain(points: readonly Vec[], closed: boolean, tol = 1e-6): Constraint[] {
  const constraints: Constraint[] = [];
  const pointCount = points.length;
  if (pointCount < 2) {
    return constraints;
  }

  // the reference the interior side is read off when the chain has no consistent turn
  const reference = closed || pointCount >= 3 ? centroid(points) : null;
  const edgeCount = closed ? pointCount : pointCount - 1;
  const turnSign = closed ? 0 : chainTurnSign(points, tol);

  for (let index = 0; index < edgeCount; index++) {
    const start = points[index]!;
    const end = points[(index + 1) % pointCount]!;

    const A = end[1] - start[1];
    const B = -(end[0] - start[0]);
    const normalLength = Math.hypot(A, B);
    if (normalLength < tol) {
      continue;
    }

    let normalizedA = A / normalLength;
    let normalizedB = B / normalLength;
    let normalizedC = normalizedA * start[0] + normalizedB * start[1];

    // a right-turning chain has its interior on the opposite side to the one
    // the natural normal selects; so does a chain with no consistent turn
    // when its reference point falls outside, or when it has no reference at all
    if (turnSign < 0 || (turnSign === 0 && (!reference || normalizedA * reference[0] + normalizedB * reference[1] > normalizedC + tol))) {
      normalizedA = -normalizedA;
      normalizedB = -normalizedB;
      normalizedC = -normalizedC;
    }

    constraints.push([normalizedA, normalizedB, normalizedC]);
  }

  return constraints;
}
