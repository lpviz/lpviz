import { describe, expect, test } from "bun:test";
import {
  VRep,
  centroid,
  classifyRegion,
  expandDegenerateBounds,
  hasOpenBoundaryClosure,
  isConvexChain,
  isConvexPolygon,
  verticesFromLines,
} from "../src/geometry";
import type { Lines, Vertices } from "../src/types";

describe("VRep.isConvex", () => {
  test("tolerates floating-point noise from a vertex dragged onto an edge", () => {
    const nearCollinear = [
      { x: 0, y: 0 },
      { x: 1, y: 1e-15 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
    ];
    expect(VRep.fromPoints(nearCollinear).isConvex()).toBe(true);
  });

  test("rejects a genuinely dented polygon", () => {
    const dent = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 0.5 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
    ];
    expect(VRep.fromPoints(dent).isConvex()).toBe(false);
  });

  test("rejects a 180-degree spike", () => {
    const spike = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
    ];
    expect(VRep.fromPoints(spike).isConvex()).toBe(false);
  });

  // Regression: a polygon that winds around itself turns the same way at every
  // vertex, so a turn-sign test calls it convex. Dragging vertices through
  // (allowed, flagged) nonconvex states can land on such a shape, and it then
  // reached the constraint builder as a valid region.
  test("rejects a self-overlapping polygon whose turns all agree", () => {
    const pentagram = starPolygon(5, 2);
    expect(VRep.fromPoints(pentagram).isConvex()).toBe(false);
    expect(isConvexPolygon(starPolygon(7, 3))).toBe(false);
    expect(isConvexPolygon(starPolygon(7, 2))).toBe(false);
    // a triangle traversed twice: the turns agree and every vertex lies on
    // every edge line's inner side, only the turning count gives it away
    const triangle = starPolygon(3, 1);
    expect(isConvexPolygon([...triangle, ...triangle])).toBe(false);
  });

  test("accepts a convex polygon with a vertex inserted on an edge", () => {
    const withInserted = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 3 },
      { x: 0, y: 3 },
    ];
    expect(isConvexPolygon(withInserted)).toBe(true);
    expect(isConvexPolygon(starPolygon(9, 1))).toBe(true);
  });
});

// The vertices of a regular n-gon visited every `step`-th one: a convex
// polygon for step 1, a star that winds `step` times around the center
// otherwise (gcd(n, step) = 1 keeps it one closed chain).
function starPolygon(count: number, step: number) {
  return Array.from({ length: count }, (_, i) => {
    const angle = (2 * Math.PI * ((i * step) % count)) / count;
    return { x: 10 * Math.cos(angle), y: 10 * Math.sin(angle) };
  });
}

describe("isConvexChain", () => {
  test("rejects a chain doubling back on itself", () => {
    expect(
      isConvexChain([
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 1, y: 0 },
      ]),
    ).toBe(false);
  });

  test("rejects a chain that spirals through more than one revolution", () => {
    // an inward spiral: every turn a left turn, five of them at 90 degrees
    expect(
      isConvexChain([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
        { x: 0, y: 2 },
        { x: 8, y: 2 },
        { x: 8, y: 8 },
      ]),
    ).toBe(false);
  });

  test("accepts straight continuation and duplicate points", () => {
    expect(
      isConvexChain([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ]),
    ).toBe(true);
    expect(
      isConvexChain([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ]),
    ).toBe(true);
  });

  // Regression: an open region whose chain is a valid convex polyline but whose
  // implied CLOSED polygon (wrap-around edge v[n-1]->v[0]) is nonconvex. Open
  // regions must be validated as chains, not closed polygons — testing them as
  // closed wrongly flagged this one nonconvex (red fill) when dragging an end
  // ray past the closure point.
  test("a convex open chain with a nonconvex closure is still a valid chain", () => {
    const openChain = [
      { x: -6.125, y: 10.1875 },
      { x: -12.175, y: 8.1875 },
      { x: -0.925, y: 14.6875 },
      { x: 10.275, y: 9.8375 },
    ];
    expect(isConvexChain(openChain)).toBe(true);
    // ...but as a closed polygon it is not convex, which is why the two tests
    // must not be conflated
    expect(VRep.fromPoints(openChain).isConvex()).toBe(false);
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
    const hasExact = verts.some(
      ([x, y]) => Math.abs(x - 0) < 1e-9 && Math.abs(y - 1) < 1e-9,
    );
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
    const strictlyFeasible = sliver.every(
      ([A, B, C]) => A * center[0]! + B * center[1]! < C,
    );
    expect(strictlyFeasible).toBe(true);
  });
});

describe("classifyRegion", () => {
  test("classifies a closed square as bounded", () => {
    expect(classifyRegion(SQUARE_LINES, verticesFromLines(SQUARE_LINES), true)).toBe(
      "bounded",
    );
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
    expect(classifyRegion(open, verticesFromLines(open), true)).toBe(
      "unbounded",
    );
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

describe("VRep.findEdgeNearPoint", () => {
  const SMALL_SQUARE = [
    { x: 0, y: 0 },
    { x: 0.3, y: 0 },
    { x: 0.3, y: 0.3 },
    { x: 0, y: 0.3 },
  ];

  test("picks the nearest edge, not the lowest index, when a small polytope puts every edge in tolerance", () => {
    const edge = VRep.fromPoints(SMALL_SQUARE);
    // the default 0.5 tolerance exceeds this square's side length, so all four
    // edges qualify for any interior point
    expect(edge.findEdgeNearPoint({ x: 0, y: 0.15 })).toBe(3);
    expect(edge.findEdgeNearPoint({ x: 0.15, y: 0.3 })).toBe(2);
    expect(edge.findEdgeNearPoint({ x: 0.3, y: 0.15 })).toBe(1);
    expect(edge.findEdgeNearPoint({ x: 0.15, y: 0 })).toBe(0);
  });

  test("still returns the right edge for a large polytope", () => {
    const big = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
    ];
    const rep = VRep.fromPoints(big);
    expect(rep.findEdgeNearPoint({ x: 0, y: 10 })).toBe(3);
    expect(rep.findEdgeNearPoint({ x: 20, y: 10 })).toBe(1);
    expect(rep.findEdgeNearPoint({ x: 10, y: 20 })).toBe(2);
  });

  test("keeps the closing edge of a closed polygon reachable", () => {
    const rep = VRep.fromPoints(SMALL_SQUARE);
    expect(rep.findEdgeNearPoint({ x: 0.15, y: 0.02 })).toBe(0);
    expect(rep.findEdgeNearPoint({ x: 0.02, y: 0.15 })).toBe(3);
  });

  test("returns null when no edge is within tolerance", () => {
    const rep = VRep.fromPoints([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
    // incenter: ~2.3 clear of every edge
    expect(rep.findEdgeNearPoint({ x: 7.3, y: 2.7 })).toBeNull();
  });

  test("isPointNearEdge agrees with the nearest-edge choice", () => {
    const rep = VRep.fromPoints(SMALL_SQUARE);
    const point = { x: 0, y: 0.15 };
    const nearest = rep.findEdgeNearPoint(point);
    expect(nearest).not.toBeNull();
    expect(rep.isPointNearEdge(point, nearest!)).toBe(true);
  });

  test("breaks exact ties by lowest index", () => {
    const rep = VRep.fromPoints([
      { x: -1, y: 0 },
      { x: 0, y: -1 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ]);
    // the centre sits sqrt(2)/2 = 0.7071... from all four edges
    expect(rep.findEdgeNearPoint({ x: 0, y: 0 }, 0.71)).toBe(0);
    expect(rep.findEdgeNearPoint({ x: 0, y: 0 }, 0.5)).toBeNull();
  });
});
