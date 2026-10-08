import { describe, expect, test } from "bun:test";
import { centroid, classifyRegion, convexHull, expandDegenerateBounds, hasOpenBoundaryClosure, isConvexChain, isConvexPolygon, nearestEdge, polygonContains, verticesFromLines } from "../src/geometry";
import type { Lines, Vec, Vertices } from "../src/types";

describe("isConvexPolygon", () => {
  test("tolerates floating-point noise from a vertex dragged onto an edge", () => {
    const nearCollinear: Vec[] = [
      [0, 0],
      [1, 1e-15],
      [2, 0],
      [2, 2],
      [0, 2],
    ];
    expect(isConvexPolygon(nearCollinear)).toBe(true);
  });

  test("rejects a genuinely dented polygon", () => {
    const dent: Vec[] = [
      [0, 0],
      [2, 0],
      [1, 0.5],
      [2, 2],
      [0, 2],
    ];
    expect(isConvexPolygon(dent)).toBe(false);
  });

  test("rejects a 180-degree spike", () => {
    const spike: Vec[] = [
      [0, 0],
      [2, 0],
      [1, 0],
      [1, 1],
    ];
    expect(isConvexPolygon(spike)).toBe(false);
  });

  // Regression: a polygon that winds around itself turns the same way at every
  // vertex, so a turn-sign test calls it convex. Dragging vertices through
  // (allowed, flagged) nonconvex states can land on such a shape, and it then
  // reached the constraint builder as a valid region.
  test("rejects a self-overlapping polygon whose turns all agree", () => {
    const pentagram = starPolygon(5, 2);
    expect(isConvexPolygon(pentagram)).toBe(false);
    expect(isConvexPolygon(starPolygon(7, 3))).toBe(false);
    expect(isConvexPolygon(starPolygon(7, 2))).toBe(false);
    // a triangle traversed twice: the turns agree and every vertex lies on
    // every edge line's inner side, only the turning count gives it away
    const triangle = starPolygon(3, 1);
    expect(isConvexPolygon([...triangle, ...triangle])).toBe(false);
  });

  test("accepts a convex polygon with a vertex inserted on an edge", () => {
    const withInserted: Vec[] = [
      [0, 0],
      [2, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ];
    expect(isConvexPolygon(withInserted)).toBe(true);
    expect(isConvexPolygon(starPolygon(9, 1))).toBe(true);
  });
});

// The vertices of a regular n-gon visited every `step`-th one: a convex
// polygon for step 1, a star that winds `step` times around the center
// otherwise (gcd(n, step) = 1 keeps it one closed chain).
function starPolygon(count: number, step: number): Vec[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = (2 * Math.PI * ((i * step) % count)) / count;
    return [10 * Math.cos(angle), 10 * Math.sin(angle)];
  });
}

describe("isConvexChain", () => {
  test("rejects a chain doubling back on itself", () => {
    expect(
      isConvexChain([
        [0, 0],
        [2, 0],
        [1, 0],
      ]),
    ).toBe(false);
  });

  test("rejects a chain that spirals through more than one revolution", () => {
    // an inward spiral: every turn a left turn, five of them at 90 degrees
    expect(
      isConvexChain([
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 2],
        [8, 2],
        [8, 8],
      ]),
    ).toBe(false);
  });

  test("accepts straight continuation and duplicate points", () => {
    expect(
      isConvexChain([
        [0, 0],
        [1, 0],
        [2, 0],
      ]),
    ).toBe(true);
    expect(
      isConvexChain([
        [0, 0],
        [1, 0],
        [1, 0],
        [1, 1],
      ]),
    ).toBe(true);
  });

  // Regression: an open region whose chain is a valid convex polyline but whose
  // implied CLOSED polygon (wrap-around edge v[n-1]->v[0]) is nonconvex. Open
  // regions must be validated as chains, not closed polygons — testing them as
  // closed wrongly flagged this one nonconvex (red fill) when dragging an end
  // ray past the closure point.
  test("a convex open chain with a nonconvex closure is still a valid chain", () => {
    const openChain: Vec[] = [
      [-6.125, 10.1875],
      [-12.175, 8.1875],
      [-0.925, 14.6875],
      [10.275, 9.8375],
    ];
    expect(isConvexChain(openChain)).toBe(true);
    // ...but as a closed polygon it is not convex, which is why the two tests
    // must not be conflated
    expect(isConvexPolygon(openChain)).toBe(false);
  });
});

// unit-normalized lines for the square [0,4] x [0,4]
const SQUARE_LINES: Lines = [
  [0, -1, 0],
  [1, 0, 4],
  [0, 1, 4],
  [-1, 0, 0],
];

describe("verticesFromLines", () => {
  test("returns full-precision vertices", () => {
    const third: Lines = [
      [0, -1, 0],
      [Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2],
      [-1, 0, 0],
    ];
    const verts = verticesFromLines(third);
    expect(verts.length).toBe(3);
    const hasExact = verts.some(([x, y]) => Math.abs(x - 0) < 1e-9 && Math.abs(y - 1) < 1e-9);
    expect(hasExact).toBe(true);
  });

  test("does not collapse a sliver thinner than 0.005 into duplicates", () => {
    // x in [0, 0.004], y in [0, 1]
    const sliver: Lines = [
      [0, -1, 0],
      [1, 0, 0.004],
      [0, 1, 1],
      [-1, 0, 0],
    ];
    const verts = verticesFromLines(sliver);
    expect(verts.length).toBe(4);
    const center = centroid(verts);
    const strictlyFeasible = sliver.every(([A, B, C]) => A * center[0] + B * center[1] < C);
    expect(strictlyFeasible).toBe(true);
  });
});

describe("classifyRegion", () => {
  test("classifies a closed square as bounded", () => {
    expect(classifyRegion(SQUARE_LINES, verticesFromLines(SQUARE_LINES))).toBe("bounded");
  });

  test("does not call a receding region with 3 vertices bounded", () => {
    // x >= 0, y >= 0, x + y >= 1, y <= 2: three vertices, recedes along +x
    const s = Math.SQRT1_2;
    const open: Lines = [
      [-1, 0, 0],
      [0, -1, 0],
      [-s, -s, -s],
      [0, 1, 2],
    ];
    expect(classifyRegion(open, verticesFromLines(open))).toBe("unbounded");
  });
});

describe("hasOpenBoundaryClosure", () => {
  test("detects the start ray crossing the terminal segment", () => {
    // pure ray-vs-segment geometry; empty lines disable the constraint fallback
    const chain: Vertices = [
      [0, 0],
      [1, 0],
      [1, 1],
      [-3, 1],
      [-3, -1],
    ];
    expect(hasOpenBoundaryClosure(chain, [])).toBe(true);
    expect(hasOpenBoundaryClosure([...chain].reverse(), [])).toBe(true);
  });

  test("an open L stays open", () => {
    const chain: Vertices = [
      [0, 0],
      [2, 0],
      [2, 2],
    ];
    expect(hasOpenBoundaryClosure(chain, [])).toBe(false);
  });
});

describe("expandDegenerateBounds", () => {
  test("expands a point and a segment, keeps real bounds", () => {
    const pt = expandDegenerateBounds({ minX: 7, maxX: 7, minY: -3, maxY: -3 });
    expect(pt.maxX - pt.minX).toBe(1);
    expect(pt.maxY - pt.minY).toBe(1);
    expect((pt.minX + pt.maxX) / 2).toBe(7);

    const seg = expandDegenerateBounds({ minX: 2, maxX: 2, minY: -5, maxY: 5 });
    expect(seg.maxX - seg.minX).toBe(1);
    expect(seg.maxY - seg.minY).toBe(10);

    const real = { minX: -10, maxX: 10, minY: -8, maxY: 8 };
    expect(expandDegenerateBounds(real)).toEqual(real);
  });
});

describe("nearestEdge", () => {
  const SMALL_SQUARE: Vec[] = [
    [0, 0],
    [0.3, 0],
    [0.3, 0.3],
    [0, 0.3],
  ];

  test("picks the nearest edge, not the lowest index, when a small polytope puts every edge in tolerance", () => {
    // the default 0.5 tolerance exceeds this square's side length, so all four
    // edges qualify for any interior point
    expect(nearestEdge(SMALL_SQUARE, [0, 0.15])).toBe(3);
    expect(nearestEdge(SMALL_SQUARE, [0.15, 0.3])).toBe(2);
    expect(nearestEdge(SMALL_SQUARE, [0.3, 0.15])).toBe(1);
    expect(nearestEdge(SMALL_SQUARE, [0.15, 0])).toBe(0);
  });

  test("still returns the right edge for a large polytope", () => {
    const big: Vec[] = [
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
    ];
    expect(nearestEdge(big, [0, 10])).toBe(3);
    expect(nearestEdge(big, [20, 10])).toBe(1);
    expect(nearestEdge(big, [10, 20])).toBe(2);
  });

  test("keeps the closing edge of a closed polygon reachable, and skips it for a polyline", () => {
    expect(nearestEdge(SMALL_SQUARE, [0.15, 0.02])).toBe(0);
    expect(nearestEdge(SMALL_SQUARE, [0.02, 0.15])).toBe(3);
    expect(nearestEdge(SMALL_SQUARE, [0.02, 0.15], 0.5, false)).not.toBe(3);
  });

  test("returns null when no edge is within tolerance", () => {
    const triangle: Vec[] = [
      [0, 0],
      [10, 0],
      [10, 10],
    ];
    // incenter: ~2.3 clear of every edge
    expect(nearestEdge(triangle, [7.3, 2.7])).toBeNull();
  });

  test("breaks exact ties by lowest index", () => {
    const diamond: Vec[] = [
      [-1, 0],
      [0, -1],
      [1, 0],
      [0, 1],
    ];
    // the centre sits sqrt(2)/2 = 0.7071... from all four edges
    expect(nearestEdge(diamond, [0, 0], 0.71)).toBe(0);
    expect(nearestEdge(diamond, [0, 0], 0.5)).toBeNull();
  });
});

describe("polygonContains and convexHull", () => {
  const square: Vec[] = [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
  ];

  test("contains interior points and not exterior ones", () => {
    expect(polygonContains(square, [2, 2])).toBe(true);
    expect(polygonContains(square, [5, 2])).toBe(false);
    expect(polygonContains(square.slice(0, 2), [2, 0])).toBe(false);
  });

  test("the hull of a dented polygon drops the dent and keeps the extreme points", () => {
    const dented: Vec[] = [
      [0, 0],
      [4, 0],
      [2, 1],
      [4, 4],
      [0, 4],
    ];
    const hull = convexHull(dented);
    expect(hull).toHaveLength(4);
    expect(isConvexPolygon(hull)).toBe(true);
    expect(hull.some(([x, y]) => x === 2 && y === 1)).toBe(false);
  });
});

describe("boundaryDirections", () => {
  // hasNontrivialRecessionDirection used Math.hypot(A, B) and
  // isObjectiveDirectionUnbounded used Math.hypot(-B, A) before they shared
  // one helper; the share is sound only if both forms, and the candidate
  // tuples built from them, agree bit for bit.
  test("Math.hypot(A, B) and Math.hypot(-B, A) agree bit for bit over 10,000 random inputs", () => {
    let seed = 12345;
    const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const magnitudes = [1, 1e-3, 1e3, 1e-150, 1e150, 1e-310, 1e308];
    const sample = (i: number, zeroEvery: number) => (i % zeroEvery === 0 ? 0 : (next() * 2 - 1) * magnitudes[Math.floor(next() * magnitudes.length)]!);
    for (let i = 0; i < 10000; i++) {
      const A = sample(i, 7);
      const B = sample(i, 11);
      const n1 = Math.hypot(A, B);
      const dx = -B;
      const dy = A;
      const n2 = Math.hypot(dx, dy);
      expect(Object.is(n1, n2)).toBe(true);
      const recession = [-B / n1, A / n1, B / n1, -A / n1];
      const objective = [dx / n2, dy / n2, -dx / n2, -dy / n2];
      for (let k = 0; k < 4; k++) expect(Object.is(recession[k], objective[k])).toBe(true);
    }
  });
});
