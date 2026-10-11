import { describe, expect, test } from "bun:test";
import { projectWorldPosition3D, viewAlignedPlaneHit, zoomPerspectivePoseAtCanvasPoint } from "../src/projection3d";
import { buildResetViewport3DView, buildViewport3DSnapshot } from "../src/view3d";
import { BASE, RECT } from "./fixtures";

const view = buildResetViewport3DView(BASE, 0, RECT);

describe("zoomPerspectivePoseAtCanvasPoint", () => {
  test("the world point under the cursor is invariant across a wheel zoom", () => {
    const cursor = { x: 800, y: 250 };
    const anchor = viewAlignedPlaneHit(buildViewport3DSnapshot(BASE, view.pose, RECT), RECT, cursor, view.pose.target);
    expect(anchor).not.toBeNull();
    for (const factor of [0.8, 1.5]) {
      const zoomed = zoomPerspectivePoseAtCanvasPoint(BASE, view.pose, RECT, cursor, view.distance * factor);
      const projected = projectWorldPosition3D(buildViewport3DSnapshot(BASE, zoomed, RECT), RECT, anchor!);
      expect(projected.x).toBeCloseTo(cursor.x, 4);
      expect(projected.y).toBeCloseTo(cursor.y, 4);
    }
  });

  test("a camera on its target has no axis to move along and keeps its pose", () => {
    const pose = { ...view.pose, position: { ...view.pose.target } };
    expect(zoomPerspectivePoseAtCanvasPoint(BASE, pose, RECT, { x: 10, y: 10 }, 50)).toBe(pose);
  });
});
