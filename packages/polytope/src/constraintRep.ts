import { centroid } from "@lpviz/math/geometry";
import type { Lines, Vertices } from "@lpviz/math/types";

export interface ConstraintRep {
  inequalities: string[];
  lines: Lines;
}

export function formatConstraintNumber(value: number): number {
  return value === Math.floor(value) ? value : parseFloat(value.toFixed(3));
}

export function formatConstraint(A: number, B: number, C: number): string {
  const normalizedA = formatConstraintNumber(A);
  const normalizedB = formatConstraintNumber(B);
  const normalizedC = formatConstraintNumber(C);

  const inequalitySign = "≤";

  let xTerm = "";
  if (normalizedA === 1) xTerm = "x";
  else if (normalizedA === -1) xTerm = "-x";
  else if (normalizedA !== 0) xTerm = `${normalizedA}x`;

  let yTerm = "";
  if (normalizedB !== 0) {
    const absoluteB = Math.abs(normalizedB);
    const yMagnitude = absoluteB === 1 ? "y" : `${absoluteB}y`;

    if (normalizedA === 0) {
      yTerm = normalizedB < 0 ? `-${yMagnitude}` : yMagnitude;
    } else {
      yTerm = normalizedB < 0 ? ` - ${yMagnitude}` : ` + ${yMagnitude}`;
    }
  }

  if (xTerm === "" && yTerm === "") {
    return `0 ${inequalitySign} ${normalizedC}`;
  }

  return `${xTerm}${yTerm} ${inequalitySign} ${normalizedC}`.trim();
}

// Which way an open chain turns, as -1 (right), +1 (left) or 0 (no consistent
// turn: collinear, or turning both ways). The natural normal (A = dy, B = -dx)
// already puts the interior on the <= side of a left-turning chain, so this is
// all that is needed to orient every edge the same way round.
//
// Reading the side off a reference point instead is unsound for an open chain:
// the reference is a mean over all the points, so one distant vertex can drag
// it across an edge and leave that edge's half-plane facing outward, which cuts
// the nodes either side of it out of the user's own region. The turn is a
// purely local property, so no single vertex can swing it. Reported against
// this share link, where a four-node chain's first node sat far outside the
// triangle the rest described:
//   https://lpviz.net/?s=AsIABJCr0QH0nI4B78iOApm_qQH0rSmGziCbrAn1xArq284D6q7OBWQA
function chainTurnSign(points: Vertices, tol: number): -1 | 0 | 1 {
  let sign: number = 0;
  for (let i = 0; i + 2 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const c = points[i + 2];
    if (!a || !b || !c) continue;
    const ax = b[0] - a[0];
    const ay = b[1] - a[1];
    const bx = c[0] - b[0];
    const by = c[1] - b[1];
    const cross = ax * by - ay * bx;
    if (Math.abs(cross) <= tol) continue;
    const next = Math.sign(cross);
    if (sign === 0) sign = next;
    else if (next !== sign) return 0;
  }
  return sign as -1 | 0 | 1;
}

export function buildConstraintRep(
  points: Vertices,
  closed: boolean,
  tol = 1e-6,
): ConstraintRep {
  const inequalities: string[] = [];
  const lines: Lines = [];
  const pointCount = points.length;
  if (pointCount < 2) {
    return { inequalities, lines };
  }

  const interiorPoint = closed || pointCount >= 3 ? centroid(points) : null;
  const edgeCount = closed ? pointCount : pointCount - 1;
  const turnSign = closed ? 0 : chainTurnSign(points, tol);

  for (let index = 0; index < edgeCount; index++) {
    const start = points[index];
    const end = points[(index + 1) % pointCount];

    const A = end[1] - start[1];
    const B = -(end[0] - start[0]);
    const normalLength = Math.hypot(A, B);
    if (normalLength < tol) {
      continue;
    }

    let normalizedA = A / normalLength;
    let normalizedB = B / normalLength;
    let normalizedC = normalizedA * start[0] + normalizedB * start[1];

    if (turnSign < 0) {
      // a right-turning chain has its interior on the opposite side to
      // the one the natural normal selects
      normalizedA = -normalizedA;
      normalizedB = -normalizedB;
      normalizedC = -normalizedC;
    } else if (
      turnSign === 0 &&
      interiorPoint &&
      normalizedA * interiorPoint[0] + normalizedB * interiorPoint[1] >
        normalizedC + tol
    ) {
      normalizedA = -normalizedA;
      normalizedB = -normalizedB;
      normalizedC = -normalizedC;
    } else if (turnSign === 0 && !interiorPoint) {
      normalizedA = -normalizedA;
      normalizedB = -normalizedB;
      normalizedC = -normalizedC;
    }

    inequalities.push(formatConstraint(normalizedA, normalizedB, normalizedC));
    lines.push([normalizedA, normalizedB, normalizedC]);
  }

  return { inequalities, lines };
}
