import { describe, expect, test } from "bun:test";
import { projectWorldPosition3D } from "../src/projection3d";
import {
  buildPerspectivePoseFromViewAngle,
  getViewportVisibleCenterCanvasPoint,
  projectCanvasPointToWorldPlane,
} from "../src/transition";
import { createDefaultViewportRenderSnapshot } from "../src/types";
import {
  buildResetViewport3DView,
  buildViewport3DSnapshot,
  fitViewport3DToBounds,
  isDefault3DView,
} from "../src/view3d";

const W = 1200;
const H = 800;
const SIDEBAR = 300;
const PAD = 50;
const rect = { width: W, height: H };

function snapshotAtAngle(viewAngle: { x: number; y: number; z: number }) {
  const base = createDefaultViewportRenderSnapshot({ width: W, height: H });
  const pose = buildPerspectivePoseFromViewAngle(viewAngle, 100, {
    x: 0,
    y: 0,
    z: 0,
  });
  return buildViewport3DSnapshot(base, pose, rect);
}

function projectedExtent(
  snap: ReturnType<typeof snapshotAtAngle>,
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  zBounds?: { minZ: number; maxZ: number },
) {
  let minPx = Infinity;
  let maxPx = -Infinity;
  let minPy = Infinity;
  let maxPy = -Infinity;
  for (const x of [bounds.minX, bounds.maxX]) {
    for (const y of [bounds.minY, bounds.maxY]) {
      for (const z of zBounds ? [zBounds.minZ, zBounds.maxZ] : [0]) {
        const p = projectWorldPosition3D(snap, rect, { x, y, z });
        minPx = Math.min(minPx, p.x);
        maxPx = Math.max(maxPx, p.x);
        minPy = Math.min(minPy, p.y);
        maxPy = Math.max(maxPy, p.y);
      }
    }
  }
  return { minPx, maxPx, minPy, maxPy };
}

describe("fitViewport3DToBounds", () => {
  const cases: Array<{
    name: string;
    viewAngle: { x: number; y: number; z: number };
    bounds: { minX: number; maxX: number; minY: number; maxY: number };
    zBounds?: { minZ: number; maxZ: number };
  }> = [
    {
      name: "flat wide, top-down",
      viewAngle: { x: 0, y: 0, z: 0 },
      bounds: { minX: -30, maxX: 30, minY: -10, maxY: 10 },
    },
    {
      name: "flat tall, top-down",
      viewAngle: { x: 0, y: 0, z: 0 },
      bounds: { minX: -5, maxX: 5, minY: -20, maxY: 20 },
    },
    {
      name: "box wide, tilted",
      viewAngle: { x: -1.15, y: 0.4, z: 0 },
      bounds: { minX: -30, maxX: 30, minY: -10, maxY: 10 },
      zBounds: { minZ: 0, maxZ: 8 },
    },
    {
      name: "box tall, tilted",
      viewAngle: { x: -1.15, y: 0.4, z: 0 },
      bounds: { minX: -5, maxX: 5, minY: -20, maxY: 20 },
      zBounds: { minZ: -3, maxZ: 12 },
    },
  ];

  for (const { name, viewAngle, bounds, zBounds } of cases) {
    test(`${name}: projected corners stay inside the padded area`, () => {
      const snap = snapshotAtAngle(viewAngle);
      const view = fitViewport3DToBounds(
        snap,
        rect,
        SIDEBAR,
        bounds,
        PAD,
        zBounds,
      );
      expect(view).not.toBeNull();
      const fitted = buildViewport3DSnapshot(snap, view!.pose, rect);
      const ext = projectedExtent(fitted, bounds, zBounds);
      expect(ext.minPx).toBeGreaterThanOrEqual(SIDEBAR + PAD - 1);
      expect(ext.maxPx).toBeLessThanOrEqual(W - PAD + 1);
      expect(ext.minPy).toBeGreaterThanOrEqual(PAD - 1);
      expect(ext.maxPy).toBeLessThanOrEqual(H - PAD + 1);
    });
  }

  test("a top inset keeps the projected content below the covered strip", () => {
    const inset = 104;
    for (const { viewAngle, bounds, zBounds } of cases) {
      const snap = snapshotAtAngle(viewAngle);
      const view = fitViewport3DToBounds(snap, rect, SIDEBAR, bounds, PAD, zBounds, inset);
      expect(view).not.toBeNull();
      const fitted = buildViewport3DSnapshot(snap, view!.pose, rect);
      const ext = projectedExtent(fitted, bounds, zBounds);
      expect(ext.minPx).toBeGreaterThanOrEqual(SIDEBAR + PAD - 1);
      expect(ext.maxPx).toBeLessThanOrEqual(W - PAD + 1);
      expect(ext.minPy).toBeGreaterThanOrEqual(inset + PAD - 1);
      expect(ext.maxPy).toBeLessThanOrEqual(H - PAD + 1);
    }
  });

  test("a degenerate (single point) bounds still produces a fit", () => {
    const snap = snapshotAtAngle({ x: 0, y: 0, z: 0 });
    const view = fitViewport3DToBounds(snap, rect, SIDEBAR, {
      minX: 7,
      maxX: 7,
      minY: -3,
      maxY: -3,
    });
    expect(view).not.toBeNull();
    expect(view!.target.y).toBeCloseTo(-3, 6);
  });
});

describe("buildResetViewport3DView", () => {
  test("places the world origin at the visible center", () => {
    const base = createDefaultViewportRenderSnapshot({ width: W, height: H });
    const view = buildResetViewport3DView(base, SIDEBAR, rect);
    const after = buildViewport3DSnapshot(base, view.pose, rect);
    const worldAtVisibleCenter = projectCanvasPointToWorldPlane(
      after,
      rect,
      getViewportVisibleCenterCanvasPoint(rect, SIDEBAR),
      0,
    );
    expect(worldAtVisibleCenter).not.toBeNull();
    expect(worldAtVisibleCenter!.x).toBeCloseTo(0, 6);
    expect(worldAtVisibleCenter!.y).toBeCloseTo(0, 6);
  });

  test("isDefault3DView accepts a fresh reset and rejects a panned view", () => {
    const base = createDefaultViewportRenderSnapshot({ width: W, height: H });
    const view = buildResetViewport3DView(base, SIDEBAR, rect);
    const after = buildViewport3DSnapshot(base, view.pose, rect);
    expect(isDefault3DView(after, SIDEBAR, rect)).toBe(true);
    const panned = {
      ...after,
      target: { ...after.target, x: after.target.x + 5 },
    };
    expect(isDefault3DView(panned, SIDEBAR, rect)).toBe(false);
  });
});

describe("projectWorldPosition3D", () => {
  test("points behind the camera never land on screen", () => {
    const snap = snapshotAtAngle({ x: -1.5, y: 0, z: 0 });
    // the camera sits near (0, -30, 2); this point is well behind it
    const p = projectWorldPosition3D(snap, rect, { x: 0, y: -90, z: 0 });
    const onScreen = p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H;
    expect(onScreen).toBe(false);
  });
});
