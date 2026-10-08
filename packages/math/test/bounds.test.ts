import { describe, expect, test } from "bun:test";
import { clipRayToBoundingBox, expandDegenerateBounds } from "../src/bounds";

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
