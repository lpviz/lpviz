import { describe, expect, test } from "bun:test";
import { regionBoundingBox } from "../src/localization";

describe("regionBoundingBox", () => {
  test("planar vertices fed to a three-variable run span the third axis by the largest extent", () => {
    const { center, halfExtents } = regionBoundingBox(
      [
        [0, 0],
        [4, 0],
        [0, 2],
      ],
      3,
      1,
    );
    expect(Array.from(center)).toEqual([2, 1, 0]);
    expect(halfExtents[1]).toBeCloseTo(halfExtents[0]! / 2);
    expect(halfExtents[2]).toBe(halfExtents[0]!);
  });

  test("a flat axis gets a floor relative to the largest extent", () => {
    const { halfExtents } = regionBoundingBox(
      [
        [0, 0],
        [4, 0],
      ],
      2,
      1,
    );
    expect(halfExtents[1]).toBeGreaterThan(0);
    expect(halfExtents[1]).toBeLessThan(halfExtents[0]!);
  });

  test("without vertices the box is the fallback around the origin, the same on every axis", () => {
    const { center, halfExtents } = regionBoundingBox([], 3, 2);
    expect(Array.from(center)).toEqual([0, 0, 0]);
    expect(halfExtents[0]).toBeGreaterThan(0);
    expect(halfExtents[1]).toBe(halfExtents[0]!);
    expect(halfExtents[2]).toBe(halfExtents[0]!);
  });

  test("the scale inflates every half extent, from a floor above one", () => {
    const tri: [number, number][] = [
      [0, 0],
      [4, 0],
      [0, 2],
    ];
    const atTwo = regionBoundingBox(tri, 2, 2).halfExtents;
    const atFour = regionBoundingBox(tri, 2, 4).halfExtents;
    expect(Array.from(atTwo)).toEqual([4, 2]);
    expect(Array.from(atFour)).toEqual([8, 4]);
    expect(regionBoundingBox(tri, 2, 0.5).halfExtents[0]).toBeGreaterThan(2);
  });
});
