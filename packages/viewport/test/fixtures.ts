import type { PointXYZ } from "@lpviz/math/types";
import { buildPerspectivePoseFromViewAngle } from "../src/perspective";
import { createDefaultViewportRenderSnapshot } from "../src/snapshot";
import { buildViewport3DSnapshot } from "../src/view3d";

/** The viewport the tests reason about, and the 2D view of the origin in it. */
export const RECT = { width: 1200, height: 800 };
export const BASE = createDefaultViewportRenderSnapshot(RECT);

const ORIGIN: PointXYZ = { x: 0, y: 0, z: 0 };

/** The 3D snapshot of a camera `distance` from `target` along `viewAngle`. */
export const snapshotAtAngle = (viewAngle: PointXYZ, distance = 100, target: PointXYZ = ORIGIN) => buildViewport3DSnapshot(BASE, buildPerspectivePoseFromViewAngle(viewAngle, distance, target), RECT);
