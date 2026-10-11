import { describe, expect, test } from "bun:test";
import { projectCanvasPointToWorldPlane, projectWorldPosition3D } from "../src/projection3d";
import { getViewportVisibleCenterCanvasPoint } from "../src/snapshot";
import { buildResetViewport3DView, buildViewport3DSnapshot, fitViewport3DToBounds } from "../src/view3d";
import { BASE, RECT, snapshotAtAngle } from "./fixtures";

const { width: W, height: H } = RECT;
const SIDEBAR = 300;
const PAD = 50;

function projectedExtent(snap: ReturnType<typeof snapshotAtAngle>, bounds: { minX: number; maxX: number; minY: number; maxY: number }, zBounds?: { minZ: number; maxZ: number }) {
  let minPx = Infinity;
  let maxPx = -Infinity;
  let minPy = Infinity;
  let maxPy = -Infinity;
  for (const x of [bounds.minX, bounds.maxX]) {
    for (const y of [bounds.minY, bounds.maxY]) {
      for (const z of zBounds ? [zBounds.minZ, zBounds.maxZ] : [0]) {
        const p = projectWorldPosition3D(snap, RECT, { x, y, z });
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

  // with and without a top inset (an open gallery), which keeps the content below the covered strip
  for (const topInset of [0, 104]) {
    for (const { name, viewAngle, bounds, zBounds } of cases) {
      test(`${name}: projected corners stay inside the padded area${topInset ? ` under a ${topInset}px top inset` : ""}`, () => {
        const snap = snapshotAtAngle(viewAngle);
        const view = fitViewport3DToBounds(snap, RECT, bounds, { sidebarWidth: SIDEBAR, padding: PAD, zBounds, topInset });
        const fitted = buildViewport3DSnapshot(snap, view.pose, RECT);
        const ext = projectedExtent(fitted, bounds, zBounds);
        expect(ext.minPx).toBeGreaterThanOrEqual(SIDEBAR + PAD - 1);
        expect(ext.maxPx).toBeLessThanOrEqual(W - PAD + 1);
        expect(ext.minPy).toBeGreaterThanOrEqual(topInset + PAD - 1);
        expect(ext.maxPy).toBeLessThanOrEqual(H - PAD + 1);
      });
    }
  }

  test("a degenerate (single point) bounds still produces a fit", () => {
    const snap = snapshotAtAngle({ x: 0, y: 0, z: 0 });
    const view = fitViewport3DToBounds(snap, RECT, { minX: 7, maxX: 7, minY: -3, maxY: -3 }, { sidebarWidth: SIDEBAR });
    expect(view.target.y).toBeCloseTo(-3, 6);
  });
});

describe("buildResetViewport3DView", () => {
  test("places the world origin at the visible center", () => {
    const base = BASE;
    const view = buildResetViewport3DView(base, SIDEBAR, RECT);
    const after = buildViewport3DSnapshot(base, view.pose, RECT);
    const worldAtVisibleCenter = projectCanvasPointToWorldPlane(after, RECT, getViewportVisibleCenterCanvasPoint(RECT, SIDEBAR), 0);
    expect(worldAtVisibleCenter).not.toBeNull();
    expect(worldAtVisibleCenter!.x).toBeCloseTo(0, 6);
    expect(worldAtVisibleCenter!.y).toBeCloseTo(0, 6);
  });
});

describe("projectWorldPosition3D", () => {
  test("points behind the camera never land on screen", () => {
    const snap = snapshotAtAngle({ x: -1.5, y: 0, z: 0 });
    // the camera sits near (0, -30, 2); this point is well behind it
    const p = projectWorldPosition3D(snap, RECT, { x: 0, y: -90, z: 0 });
    const onScreen = p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H;
    expect(onScreen).toBe(false);
  });
});
