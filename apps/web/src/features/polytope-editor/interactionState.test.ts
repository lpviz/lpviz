import { describe, expect, test } from "bun:test";
import type { Vec } from "@lpviz/math/types";
import { findEdgeNearPoint } from "./interactionState";

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

const midOf = (a: Vec, b: Vec): Vec => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

describe("findEdgeNearPoint", () => {
  test("snaps a click on each edge to that edge, not to edge 0", () => {
    const on = (i: number) => findEdgeNearPoint(midOf(SMALL_SQUARE[i]!, SMALL_SQUARE[(i + 1) % 4]!), SMALL_SQUARE, "closed");
    expect(on(0)).toBe(0);
    expect(on(1)).toBe(1);
    expect(on(2)).toBe(2);
    expect(on(3)).toBe(3);
  });

  test("prefers the closer of two edges both inside the tolerance", () => {
    const near = (point: Vec) => findEdgeNearPoint(point, SMALL_SQUARE, "closed");
    // 0.02 off the left edge, 0.10 off the top edge
    expect(near([0.02, 0.2])).toBe(3);
    expect(near([0.1, 0.28])).toBe(2);
  });

  test("keeps the closing edge reachable in closed mode", () => {
    expect(findEdgeNearPoint([0.15, 0.02], SMALL_SQUARE, "closed")).toBe(0);
  });

  test("does not test the closing edge in draft or open mode", () => {
    // the last->first chord is this square's left edge, which only becomes a
    // boundary once the chain is closed
    const point: Vec = [0.02, 0.15];
    expect(findEdgeNearPoint(point, SMALL_SQUARE, "closed")).toBe(3);
    expect(findEdgeNearPoint(point, SMALL_SQUARE, "draft")).not.toBe(3);
    expect(findEdgeNearPoint(point, SMALL_SQUARE, "open")).not.toBe(3);
  });

  test("an exact tie between edges goes to the lowest index", () => {
    // the centre of the square is 0.15 from the bottom, right and top edges
    expect(findEdgeNearPoint([0.15, 0.15], SMALL_SQUARE, "draft")).toBe(0);
  });

  test("returns null when no edge is within tolerance", () => {
    expect(findEdgeNearPoint([-1, 0.15], SMALL_SQUARE, "closed")).toBeNull();
  });

  test("the tolerance is in world units, so a tighter one drops far edges", () => {
    // 0.02 from the left edge and 0.13 from the top: only the left edge
    // survives a 0.05 tolerance
    expect(findEdgeNearPoint([0.02, 0.17], SMALL_SQUARE, "closed", 0.05)).toBe(3);
    expect(findEdgeNearPoint([0.1, 0.17], SMALL_SQUARE, "closed", 0.05)).toBeNull();
  });

  test("still picks the right edge for a large polytope", () => {
    const big: Vec[] = [
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
    ];
    expect(findEdgeNearPoint([0, 10], big, "closed")).toBe(3);
    expect(findEdgeNearPoint([20, 10], big, "closed")).toBe(1);
    expect(findEdgeNearPoint([10, 20], big, "closed")).toBe(2);
  });

  test("skips degenerate zero-length edges", () => {
    const withDuplicate: Vec[] = [
      [0, 0],
      [0, 0],
      [0.3, 0],
    ];
    expect(findEdgeNearPoint([0.15, 0], withDuplicate, "open")).toBe(1);
  });
});
