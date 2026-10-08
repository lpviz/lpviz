import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { DEFAULT_VIEW_ANGLE } from "../src/defaults";
import {
  buildViewport2DSnapshot,
  buildViewport2DStateFromTarget,
  clampScaleFactor2D,
  deriveViewport2DState,
  fitViewport2DToBounds,
  toCanvasCoords2D,
  toLogicalCoords2D,
  zoomViewport2DStateAtCanvasPoint,
} from "../src/projection2d";
import { projectWorldPosition3D, toCanvasCoords3D, toLogicalCoords3D, type Viewport3DInteractionOptions } from "../src/projection3d";
import {
  buildPerspectivePoseFromViewAngle,
  buildTransitionCompleteState,
  buildTransitionStartState,
  buildViewport2DStateFromTransitionFrame,
  buildViewportTransitionFrame,
  buildViewportTransitionPlan,
  getPerspectiveDistanceForUnitsPerPixel,
  getScaleFactorFromPerspectiveDistance,
  getViewportVisibleCenterCanvasPoint,
  projectCanvasPointToWorldPlane,
} from "../src/transition";
import { createDefaultViewportRenderSnapshot, type ViewportRenderSnapshot } from "../src/types";
import { buildResetViewport3DView, buildViewport3DSnapshot, fitViewport3DToBounds, getDefaultPerspectiveDistance3D, getMaxPerspectiveDistance3D, getViewAngleFromSnapshot3D } from "../src/view3d";

// Pins the exact output of every viewport function over a fixed grid of
// inputs so the package can be refactored bit-for-bit. Numbers are serialized
// with their sign of zero and NaN intact and the whole transcript is hashed;
// set PIN_DUMP=path to write the transcript when the hash changes.
const EXPECTED_HASH = "ecc0d5055917609c1b05ed52344ed891bbe9ef640f4e3f39df1dc6496563a116";

const fmt = (v: unknown): string => {
  if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v);
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(fmt).join(",")}]`;
  return `{${Object.entries(v)
    .map(([k, x]) => `${k}:${fmt(x)}`)
    .join(",")}}`;
};

const RECTS = [
  { width: 1200, height: 800 },
  { width: 800, height: 600 },
  { width: 375, height: 667 },
  { width: 1, height: 1 },
];
const VIEW_ANGLES = [DEFAULT_VIEW_ANGLE, { x: 0, y: 0, z: 0 }, { x: -1.5, y: 0, z: 0 }, { x: -1.56, y: 0.3, z: 0.1 }, { x: -0.8, y: 1.2, z: -0.4 }, { x: 0.5, y: -0.5, z: 0.5 }];
const DISTANCES = [10, 100, 1000];
const TARGETS = [
  { x: 0, y: 0, z: 0 },
  { x: 5, y: -3, z: 2 },
];
const SIDEBARS = [0, 300];
const ANCHORS = [
  { x: 3, y: -2, z: 1.5 },
  { x: -40, y: 25, z: 0 },
];
const OPTION_VARIANTS: Viewport3DInteractionOptions[] = [
  { zScale: 0.1, snapToGrid: false, editorInteractionKind: "idle", is3DMode: true, isTransitioning3D: false },
  { zScale: 0.1, snapToGrid: true, editorInteractionKind: "idle", is3DMode: true, isTransitioning3D: false },
  { zScale: 0.1, snapToGrid: false, editorInteractionKind: "drag", is3DMode: true, isTransitioning3D: false, viewAnchor3D: ANCHORS[0] },
  { zScale: 2.5, snapToGrid: true, editorInteractionKind: "drag", is3DMode: false, isTransitioning3D: true, viewAnchor3D: ANCHORS[1] },
  { zScale: 0.0001, snapToGrid: false, editorInteractionKind: "drag", is3DMode: false, isTransitioning3D: false, viewAnchor3D: ANCHORS[0] },
];
const BOUNDS = [
  { minX: -30, maxX: 30, minY: -10, maxY: 10 },
  { minX: -5, maxX: 5, minY: -20, maxY: 20 },
  { minX: 7, maxX: 7, minY: -3, maxY: -3 },
  { minX: 0, maxX: 1e-9, minY: 0, maxY: 1e-9 },
];
const Z_BOUNDS = [undefined, { minZ: 0, maxZ: 8 }, { minZ: -3, maxZ: 12 }];

const canvasGrid = (rect: { width: number; height: number }) => {
  const points: Array<{ x: number; y: number }> = [];
  for (const fx of [0, 0.25, 0.5, 0.75, 1]) {
    for (let i = 0; i <= 10; i++) {
      points.push({ x: fx * rect.width, y: (i / 10) * rect.height });
    }
  }
  return points;
};

function buildTranscript() {
  const constraints: string[] = [];
  const record = (label: string, value: unknown) => constraints.push(`${label}=${fmt(value)}`);
  const snapshots: ViewportRenderSnapshot[] = [];

  for (const rect of RECTS) {
    const base = createDefaultViewportRenderSnapshot(rect);
    snapshots.push(base);
    const tag = `${rect.width}x${rect.height}`;
    const canvasPoints = canvasGrid(rect);

    for (const sidebar of SIDEBARS) {
      record(`${tag} visibleCenter ${sidebar}`, getViewportVisibleCenterCanvasPoint(rect, sidebar));
      record(`${tag} reset ${sidebar}`, buildResetViewport3DView(base, sidebar, rect));
    }
    record(`${tag} defaultDistance`, [getDefaultPerspectiveDistance3D(base, rect), getDefaultPerspectiveDistance3D(base), getMaxPerspectiveDistance3D(base, rect), getMaxPerspectiveDistance3D(base)]);
    for (const upp of [0.001, 0.05, 1, 40]) {
      record(`${tag} distanceFor ${upp}`, [getPerspectiveDistanceForUnitsPerPixel(base, upp), getPerspectiveDistanceForUnitsPerPixel(base, upp, 333)]);
    }
    for (const d of [0, 5, 10, 123.4, 1e5]) {
      record(`${tag} scaleFor ${d}`, [getScaleFactorFromPerspectiveDistance(base, d), getScaleFactorFromPerspectiveDistance(base, d, 333)]);
    }

    for (const [vi, viewAngle] of VIEW_ANGLES.entries()) {
      for (const distance of DISTANCES) {
        for (const [ti, target] of TARGETS.entries()) {
          const key = `${tag} v${vi} d${distance} t${ti}`;
          const pose = buildPerspectivePoseFromViewAngle(viewAngle, distance, target);
          record(`${key} pose`, pose);
          const snap = buildViewport3DSnapshot(base, pose, rect);
          snapshots.push(snap, buildViewport3DSnapshot(base, pose));
          record(`${key} snapshot`, snap);
          record(`${key} viewAngle`, getViewAngleFromSnapshot3D(snap));

          for (const [pi, p] of canvasPoints.entries()) {
            for (const [oi, options] of OPTION_VARIANTS.entries()) {
              record(`${key} p${pi} o${oi} logical`, toLogicalCoords3D(snap, rect, p.x, p.y, options));
            }
            for (const z of [0, 2.5, -7]) {
              record(`${key} p${pi} plane ${z}`, projectCanvasPointToWorldPlane(snap, rect, p, z));
            }
          }
          for (const x of [-20, 0, 15]) {
            for (const y of [-10, 0, 25]) {
              for (const z of [-5, 0, 30]) {
                record(`${key} world ${x},${y},${z}`, projectWorldPosition3D(snap, rect, { x, y, z }));
              }
              record(`${key} canvas ${x},${y}`, [
                toCanvasCoords3D(snap, rect, { x, y }, undefined, 0.1),
                toCanvasCoords3D(snap, rect, { x, y }, 7, 0.1),
                toCanvasCoords3D(snap, rect, { x, y }, x * 2 + y, 2.5),
                projectWorldPosition3D(snap, rect, { x, y, z: 0 }),
              ]);
            }
          }

          for (const targetMode of [true, false]) {
            const plan = buildViewportTransitionPlan({ snapshot: snap, targetMode, viewAngle });
            record(`${key} plan ${targetMode}`, plan);
            record(`${key} start ${targetMode}`, buildTransitionStartState(targetMode, 1234.5, plan));
            record(`${key} complete ${targetMode}`, buildTransitionCompleteState(plan));
            for (const progress of [-0.5, 0, 0.25, 0.5, 1, 1.5]) {
              const frame = buildViewportTransitionFrame(plan, progress, rect);
              snapshots.push(frame.snapshot);
              record(`${key} frame ${targetMode} ${progress}`, frame);
              for (const sidebar of SIDEBARS) {
                record(`${key} frame2d ${targetMode} ${progress} ${sidebar}`, buildViewport2DStateFromTransitionFrame(plan, frame, rect, sidebar));
              }
            }
          }

          if (distance === 100) {
            for (const sidebar of SIDEBARS) {
              record(`${key} reset ${sidebar}`, buildResetViewport3DView(snap, sidebar, rect));
              for (const [bi, bounds] of BOUNDS.entries()) {
                for (const [zi, zBounds] of Z_BOUNDS.entries()) {
                  for (const padding of [50, 0]) {
                    for (const topInset of [0, 104]) {
                      record(`${key} fit ${sidebar} b${bi} z${zi} ${padding} ${topInset}`, fitViewport3DToBounds(snap, rect, sidebar, bounds, padding, zBounds, topInset));
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    for (const gridSpacing of [20, 30, 1]) {
      for (const scaleFactor of [0.01, 0.05, 1, 2.7, 400, 1e4, NaN]) {
        for (const [ti, target] of TARGETS.entries()) {
          for (const sidebar of SIDEBARS) {
            const key = `${tag} 2d g${gridSpacing} s${scaleFactor} t${ti} ${sidebar}`;
            const state = buildViewport2DStateFromTarget(target, scaleFactor, gridSpacing, sidebar);
            record(`${key} state`, state);
            const snap = buildViewport2DSnapshot(state, sidebar, rect, base);
            snapshots.push(snap);
            record(`${key} snapshot`, snap);
            for (const p of [
              { x: 0, y: 0 },
              { x: rect.width / 2, y: rect.height / 2 },
              { x: rect.width - 1, y: 12 },
            ]) {
              record(`${key} logical ${p.x},${p.y}`, [toLogicalCoords2D(snap, rect, p.x, p.y), toLogicalCoords2D(snap, rect, p.x, p.y, { snapToGrid: true })]);
              record(`${key} zoom ${p.x},${p.y}`, zoomViewport2DStateAtCanvasPoint(state, sidebar, rect, base, p, scaleFactor * 1.2));
            }
            for (const w of [
              { x: 0, y: 0 },
              { x: 5.5, y: -2.25 },
              { x: -8, y: 7 },
            ]) {
              record(`${key} canvas ${w.x},${w.y}`, toCanvasCoords2D(snap, rect, w));
            }
            for (const [bi, bounds] of BOUNDS.entries()) {
              record(`${key} fit b${bi}`, [fitViewport2DToBounds(state, sidebar, rect, base, bounds), fitViewport2DToBounds(state, sidebar, rect, base, bounds, 0, 104)]);
            }
          }
        }
      }
    }
  }

  for (const [si, snap] of snapshots.entries()) {
    for (const sidebar of SIDEBARS) {
      record(`derive ${si} ${sidebar}`, deriveViewport2DState(snap, sidebar));
    }
  }

  return { constraints, snapshots };
}

describe("viewport pin", () => {
  const { constraints, snapshots } = buildTranscript();

  test("every function's output over the grid is unchanged", () => {
    const transcript = constraints.join("\n");
    const hash = createHash("sha256").update(transcript).digest("hex");
    if (hash !== EXPECTED_HASH && process.env.PIN_DUMP) writeFileSync(process.env.PIN_DUMP, transcript);
    expect(constraints.length).toBeGreaterThan(50000);
    expect(hash).toBe(EXPECTED_HASH);
  });

  test("every builder keeps unitsPerPixel = 1 / (gridSpacing * clamped scaleFactor)", () => {
    expect(snapshots.length).toBeGreaterThan(500);
    for (const snap of snapshots) {
      const expected = 1 / (snap.gridSpacing * clampScaleFactor2D(snap.scaleFactor));
      expect(Object.is(snap.unitsPerPixel, expected)).toBe(true);
    }
  });

  test("a grazing ray falls back to the target, and to the view-anchor plane when one is given", () => {
    const rect = RECTS[0]!;
    // camera 1.5 rad from top-down: nearly in the z = 0 plane, so the top of
    // the canvas looks above the horizon and never meets the plane
    const snap = buildViewport3DSnapshot(createDefaultViewportRenderSnapshot(rect), buildPerspectivePoseFromViewAngle({ x: -1.5, y: 0, z: 0 }, 100, { x: 5, y: -3, z: 2 }), rect);
    const base: Viewport3DInteractionOptions = { zScale: 0.1, snapToGrid: false, editorInteractionKind: "idle", is3DMode: true, isTransitioning3D: false };
    expect(projectCanvasPointToWorldPlane(snap, rect, { x: 600, y: 0 }, 0)).toBeNull();
    expect(toLogicalCoords3D(snap, rect, 600, 0, base)).toEqual({ x: 5, y: -3 });
    const anchored = toLogicalCoords3D(snap, rect, 600, 0, { ...base, viewAnchor3D: { x: 3, y: -2, z: 1.5 } });
    expect(anchored).not.toEqual({ x: 5, y: -3 });
    expect(Number.isFinite(anchored.x) && Number.isFinite(anchored.y)).toBe(true);
    // well below the horizon the ray meets the plane directly
    expect(projectCanvasPointToWorldPlane(snap, rect, { x: 600, y: 790 }, 0)).not.toBeNull();
  });
});
