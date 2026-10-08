import { describe, expect, test } from "bun:test";
import { centroid, convexHull, isConvexChain, isConvexPolygon, nearestEdge, polygonContains } from "../src/polygon";
import type { Vec } from "../src/types";

// The vertices of a regular n-gon visited every `step`-th one: a convex
// polygon for step 1, a star that winds `step` times around the center
// otherwise (gcd(n, step) = 1 keeps it one closed chain).
function starPolygon(count: number, step: number): Vec[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = (2 * Math.PI * ((i * step) % count)) / count;
    return [10 * Math.cos(angle), 10 * Math.sin(angle)];
  });
}

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
    expect(isConvexPolygon(starPolygon(5, 2))).toBe(false);
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

describe("centroid", () => {
  test("averages every coordinate of points of any dimension", () => {
    expect(
      centroid([
        [0, 0],
        [4, 2],
      ]),
    ).toEqual([2, 1]);
    expect(
      centroid([
        [1, 2, 3],
        [3, 4, 5],
      ]),
    ).toEqual([2, 3, 4]);
    expect(() => centroid([])).toThrow();
  });
});

describe("nearestEdge", () => {
  // A square whose side is under the default 0.5 tolerance, which is what a
  // small polytope looks like once the view is zoomed in on it: every edge is
  // within tolerance of every interior point, so the pick has to be by distance
  // rather than by index order.
  const SMALL_SQUARE: Vec[] = [
    [0, 0],
    [0.3, 0],
    [0.3, 0.3],
    [0, 0.3],
  ];

  test("picks the nearest edge, not the lowest index, when every edge is in tolerance", () => {
    expect(nearestEdge(SMALL_SQUARE, [0, 0.15])).toBe(3);
    expect(nearestEdge(SMALL_SQUARE, [0.15, 0.3])).toBe(2);
    expect(nearestEdge(SMALL_SQUARE, [0.3, 0.15])).toBe(1);
    expect(nearestEdge(SMALL_SQUARE, [0.15, 0])).toBe(0);
    // 0.02 off the left edge, 0.10 off the top edge
    expect(nearestEdge(SMALL_SQUARE, [0.02, 0.2])).toBe(3);
    expect(nearestEdge(SMALL_SQUARE, [0.1, 0.28])).toBe(2);
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
    // the last->first chord is this square's left edge, which only becomes a
    // boundary once the chain is closed
    expect(nearestEdge(SMALL_SQUARE, [0.02, 0.15], 0.5, false)).not.toBe(3);
    // the centre of the square is 0.15 from the bottom, right and top edges
    expect(nearestEdge(SMALL_SQUARE, [0.15, 0.15], 0.5, false)).toBe(0);
  });

  test("returns null when no edge is within tolerance, in world units", () => {
    const triangle: Vec[] = [
      [0, 0],
      [10, 0],
      [10, 10],
    ];
    // incenter: ~2.3 clear of every edge
    expect(nearestEdge(triangle, [7.3, 2.7])).toBeNull();
    expect(nearestEdge(SMALL_SQUARE, [-1, 0.15])).toBeNull();
    // 0.02 from the left edge and 0.13 from the top: only the left edge
    // survives a 0.05 tolerance
    expect(nearestEdge(SMALL_SQUARE, [0.02, 0.17], 0.05)).toBe(3);
    expect(nearestEdge(SMALL_SQUARE, [0.1, 0.17], 0.05)).toBeNull();
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

  test("skips degenerate zero-length edges", () => {
    const withDuplicate: Vec[] = [
      [0, 0],
      [0, 0],
      [0.3, 0],
    ];
    expect(nearestEdge(withDuplicate, [0.15, 0], 0.5, false)).toBe(1);
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
