import { describe, expect, test } from "bun:test";
import {
  buildViewport2DSnapshot,
  buildViewport2DStateFromTarget,
  fitViewport2DToBounds,
  toCanvasCoords2D,
  toLogicalCoords2D,
  zoomViewport2DStateAtCanvasPoint,
} from "../src/projection2d";
import { createDefaultViewportRenderSnapshot } from "../src/types";

// Round-trip invariants for the 2D projection. These pin the canvas<->world
// mapping so the Phase 5 viewport rewrite (which will move this math behind a
// ViewportMode interface) can be proven equivalent.
const rect = { width: 1200, height: 800 };
const fallback = createDefaultViewportRenderSnapshot(rect);

function snapshotAt(target: { x: number; y: number }, scaleFactor: number) {
  const state = buildViewport2DStateFromTarget(target, scaleFactor, 30, 0);
  return buildViewport2DSnapshot(state, 0, rect, fallback);
}

describe("2D projection round-trips", () => {
  const snap = snapshotAt({ x: 2, y: -3 }, 1.5);

  test("toLogical ∘ toCanvas ≈ identity (world space)", () => {
    for (const p of [
      { x: 0, y: 0 },
      { x: 5.5, y: -2.25 },
      { x: -8, y: 7 },
    ]) {
      const c = toCanvasCoords2D(snap, rect, p);
      const back = toLogicalCoords2D(snap, rect, c.x, c.y);
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });

  test("toCanvas ∘ toLogical ≈ identity (canvas space)", () => {
    for (const c of [
      { x: 0, y: 0 },
      { x: 600, y: 400 },
      { x: 1199, y: 12 },
    ]) {
      const world = toLogicalCoords2D(snap, rect, c.x, c.y);
      const canvas = toCanvasCoords2D(snap, rect, world);
      expect(canvas.x).toBeCloseTo(c.x, 6);
      expect(canvas.y).toBeCloseTo(c.y, 6);
    }
  });

  test("the world point under the cursor is invariant across a zoom", () => {
    const state = buildViewport2DStateFromTarget({ x: 1, y: 1 }, 1, 30, 0);
    const before = buildViewport2DSnapshot(state, 0, rect, fallback);
    const cursor = { x: 800, y: 250 };
    const worldBefore = toLogicalCoords2D(before, rect, cursor.x, cursor.y);
    const zoomed = zoomViewport2DStateAtCanvasPoint(
      state,
      0,
      rect,
      before,
      cursor,
      state.scaleFactor * 1.2,
    );
    const after = buildViewport2DSnapshot(zoomed, 0, rect, fallback);
    const worldAfter = toLogicalCoords2D(after, rect, cursor.x, cursor.y);
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 4);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 4);
  });
});

describe("fitViewport2DToBounds", () => {
  const bounds = { minX: -10, maxX: 10, minY: -30, maxY: 30 };
  const base = buildViewport2DStateFromTarget({ x: 0, y: 0 }, 1, 30, 0);
  const canvasOf = (state: typeof base, point: { x: number; y: number }) =>
    toCanvasCoords2D(buildViewport2DSnapshot(state, 0, rect, fallback), rect, point);

  test("with no inset the content is centered and fills the padded height", () => {
    const fitted = fitViewport2DToBounds(base, 0, rect, fallback, bounds, 50);
    const top = canvasOf(fitted, { x: 0, y: bounds.maxY });
    const bottom = canvasOf(fitted, { x: 0, y: bounds.minY });
    expect(top.y).toBeCloseTo(50, 6);
    expect(bottom.y).toBeCloseTo(rect.height - 50, 6);
  });

  test("a top inset keeps the content below it and centers it in what remains", () => {
    const inset = 104;
    const fitted = fitViewport2DToBounds(base, 0, rect, fallback, bounds, 50, inset);
    const top = canvasOf(fitted, { x: 0, y: bounds.maxY });
    const bottom = canvasOf(fitted, { x: 0, y: bounds.minY });
    expect(top.y).toBeCloseTo(inset + 50, 6);
    expect(bottom.y).toBeCloseTo(rect.height - 50, 6);
  });
});
