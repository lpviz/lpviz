import { describe, expect, test } from "bun:test";
import { findEdgeNearPoint } from "./interactionState";

// A square whose side is under the default 0.5 tolerance, which is what a
// small polytope looks like once the view is zoomed in on it: every edge is
// within tolerance of every interior point, so the pick has to be by distance
// rather than by index order.
const SMALL_SQUARE = [
  { x: 0, y: 0 },
  { x: 0.3, y: 0 },
  { x: 0.3, y: 0.3 },
  { x: 0, y: 0.3 },
];

const midOf = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});

describe("findEdgeNearPoint", () => {
  test("snaps a click on each edge to that edge, not to edge 0", () => {
    const on = (i: number) =>
      findEdgeNearPoint(
        midOf(SMALL_SQUARE[i], SMALL_SQUARE[(i + 1) % 4]),
        SMALL_SQUARE,
        "closed",
      );
    expect(on(0)).toBe(0);
    expect(on(1)).toBe(1);
    expect(on(2)).toBe(2);
    expect(on(3)).toBe(3);
  });

  test("prefers the closer of two edges both inside the tolerance", () => {
    const near = (point: { x: number; y: number }) =>
      findEdgeNearPoint(point, SMALL_SQUARE, "closed");
    // 0.02 off the left edge, 0.10 off the top edge
    expect(near({ x: 0.02, y: 0.2 })).toBe(3);
    expect(near({ x: 0.1, y: 0.28 })).toBe(2);
  });

  test("keeps the closing edge reachable in closed mode", () => {
    expect(
      findEdgeNearPoint({ x: 0.15, y: 0.02 }, SMALL_SQUARE, "closed"),
    ).toBe(0);
  });

  test("does not test the closing edge in draft or open mode", () => {
    // the last->first chord is this square's left edge, which only becomes a
    // boundary once the chain is closed
    const point = { x: 0.02, y: 0.15 };
    expect(findEdgeNearPoint(point, SMALL_SQUARE, "closed")).toBe(3);
    expect(findEdgeNearPoint(point, SMALL_SQUARE, "draft")).not.toBe(3);
    expect(findEdgeNearPoint(point, SMALL_SQUARE, "open")).not.toBe(3);
  });

  test("returns null when the point is past every edge end", () => {
    expect(
      findEdgeNearPoint({ x: 0.15, y: 0.15 }, SMALL_SQUARE, "draft"),
    ).toBe(0);
    expect(
      findEdgeNearPoint({ x: -1, y: 0.15 }, SMALL_SQUARE, "closed"),
    ).toBeNull();
  });

  test("still picks the right edge for a large polytope", () => {
    const big = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
    ];
    expect(findEdgeNearPoint({ x: 0, y: 10 }, big, "closed")).toBe(3);
    expect(findEdgeNearPoint({ x: 20, y: 10 }, big, "closed")).toBe(1);
    expect(findEdgeNearPoint({ x: 10, y: 20 }, big, "closed")).toBe(2);
  });

  test("skips degenerate zero-length edges", () => {
    const withDuplicate = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0.3, y: 0 },
    ];
    expect(findEdgeNearPoint({ x: 0.15, y: 0 }, withDuplicate, "open")).toBe(1);
  });
});
