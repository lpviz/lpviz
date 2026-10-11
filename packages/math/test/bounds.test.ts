import { describe, expect, test } from "bun:test";
import { clipHalfPlanesToBoundingBox, clipLineToBoundingBox, clipRayToBoundingBox, expandDegenerateBounds } from "../src/bounds";

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

describe("clipRayToBoundingBox", () => {
  const box = { minX: -5, maxX: 5, minY: -5, maxY: 5 };

  test("clips a ray from inside the box to its far boundary", () => {
    expect(clipRayToBoundingBox({ start: [0, 0], direction: [1, 0] }, box)).toEqual([
      [0, 0],
      [5, 0],
    ]);
  });

  test("returns null for a ray that leaves the box behind it", () => {
    expect(clipRayToBoundingBox({ start: [10, 0], direction: [1, 0] }, box)).toBeNull();
  });
});

describe("clipLineToBoundingBox", () => {
  const box = { minX: -5, maxX: 5, minY: -2, maxY: 2 };

  test("spans the box along the line's gentler axis", () => {
    // y = x / 2: gentler along x, so the points sit on the box's x extent
    expect(clipLineToBoundingBox([-1, 2, 0], box)).toEqual([
      [-5, -2.5],
      [5, 2.5],
    ]);
    // x = 1: vertical, so the points sit on the box's y extent
    expect(clipLineToBoundingBox([1, 0, 1], box)).toEqual([
      [1, -2],
      [1, 2],
    ]);
  });

  test("has no points for a degenerate line", () => {
    expect(clipLineToBoundingBox([0, 0, 1], box)).toBeNull();
  });
});

describe("clipHalfPlanesToBoundingBox", () => {
  const box = { minX: 0, maxX: 4, minY: 0, maxY: 4 };

  test("keeps the part of the box the half-planes leave", () => {
    // x <= 2 and x + y <= 5 cut the square down to a pentagon
    expect(
      clipHalfPlanesToBoundingBox(
        [
          [1, 0, 2],
          [1, 1, 5],
        ],
        box,
      ),
    ).toEqual([
      [0, 0],
      [2, 0],
      [2, 3],
      [1, 4],
      [0, 4],
    ]);
  });

  test("is empty once a half-plane excludes the whole box", () => {
    expect(clipHalfPlanesToBoundingBox([[1, 0, -1]], box)).toEqual([]);
  });
});
