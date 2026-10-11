import { describe, expect, test } from "bun:test";
import { projectWorldPosition3D, viewAlignedPlaneHit, zoomPerspectivePoseAtCanvasPoint } from "../src/projection3d";
import { createDefaultViewportRenderSnapshot } from "../src/snapshot";
import { buildResetViewport3DView, buildViewport3DSnapshot } from "../src/view3d";

const rect = { width: 1200, height: 800 };
const base = createDefaultViewportRenderSnapshot(rect);
const view = buildResetViewport3DView(base, 0, rect);

describe("zoomPerspectivePoseAtCanvasPoint", () => {
  test("the world point under the cursor is invariant across a wheel zoom", () => {
    const cursor = { x: 800, y: 250 };
    const anchor = viewAlignedPlaneHit(buildViewport3DSnapshot(base, view.pose, rect), rect, cursor, view.pose.target);
    expect(anchor).not.toBeNull();
    for (const factor of [0.8, 1.5]) {
      const zoomed = zoomPerspectivePoseAtCanvasPoint(base, view.pose, rect, cursor, view.distance * factor);
      const projected = projectWorldPosition3D(buildViewport3DSnapshot(base, zoomed, rect), rect, anchor!);
      expect(projected.x).toBeCloseTo(cursor.x, 4);
      expect(projected.y).toBeCloseTo(cursor.y, 4);
    }
  });

  test("a camera on its target has no axis to move along and keeps its pose", () => {
    const pose = { ...view.pose, position: { ...view.pose.target } };
    expect(zoomPerspectivePoseAtCanvasPoint(base, pose, rect, { x: 10, y: 10 }, 50)).toBe(pose);
  });
});
