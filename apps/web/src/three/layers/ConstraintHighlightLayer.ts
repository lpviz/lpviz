import { getState } from "@/features/core/store";
import { getViewportRenderSnapshot } from "@/features/viewport/runtime/snapshot";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { type BoundingBox } from "@lpviz/math/geometry";
import type { Line, PointXY } from "@lpviz/math/types";
import { hasPolytopeLines } from "@lpviz/polytope/polytopeTypes";
import { projectCanvasPointToWorldPlane } from "@lpviz/viewport/transition";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { shouldRenderSnapshotMode } from "../helpers/sceneVisibility";
import { lineDepthMaterial, lineGeometry, replaceLinePositions, setupLine } from "../helpers/sharedLineMaterials";
import { CLIP_MARGIN_UNITS, visibleBounds2D } from "../helpers/visibleBounds";
import { LayerBase } from "./base/LayerBase";

const CONSTRAINT_COLOR = "#ff0000";
const CONSTRAINT_RENDER_ORDER = RENDER_ORDER.constraintLines;
const CONSTRAINT_LINE_THICKNESS = 2;
const DEFAULT_3D_EXTENT = 5000;
const EPS = 1e-10;

function getVisibleBounds(snap: ViewportRenderSnapshot): BoundingBox {
  if (snap.mode === "2d") {
    return visibleBounds2D(snap);
  }
  const rect = {
    width: Math.max(1, snap.width),
    height: Math.max(1, snap.height),
  };
  const screenPoints = [
    { x: 0, y: 0 },
    { x: rect.width / 2, y: 0 },
    { x: rect.width, y: 0 },
    { x: 0, y: rect.height / 2 },
    { x: rect.width, y: rect.height / 2 },
    { x: 0, y: rect.height },
    { x: rect.width / 2, y: rect.height },
    { x: rect.width, y: rect.height },
  ];
  const pts = screenPoints.map((p) => projectCanvasPointToWorldPlane(snap, rect, p, 0)).filter((p): p is PointXY => p !== null);
  if (pts.length === 0) {
    return {
      minX: -DEFAULT_3D_EXTENT,
      maxX: DEFAULT_3D_EXTENT,
      minY: -DEFAULT_3D_EXTENT,
      maxY: DEFAULT_3D_EXTENT,
    };
  }
  return {
    minX: Math.min(...pts.map((p) => p.x)) - CLIP_MARGIN_UNITS,
    maxX: Math.max(...pts.map((p) => p.x)) + CLIP_MARGIN_UNITS,
    minY: Math.min(...pts.map((p) => p.y)) - CLIP_MARGIN_UNITS,
    maxY: Math.max(...pts.map((p) => p.y)) + CLIP_MARGIN_UNITS,
  };
}

function clipLineToBounds(line: Line, b: BoundingBox): [PointXY, PointXY] | null {
  const [A, B, C] = line;
  if (Math.abs(A) < EPS && Math.abs(B) < EPS) return null;
  if (Math.abs(B) > Math.abs(A)) {
    return [
      { x: b.minX, y: (C - A * b.minX) / B },
      { x: b.maxX, y: (C - A * b.maxX) / B },
    ];
  }
  return [
    { y: b.minY, x: (C - B * b.minY) / A },
    { y: b.maxY, x: (C - B * b.maxY) / A },
  ];
}

export class ConstraintHighlightLayer extends LayerBase {
  readonly object3D = setupLine(new LineSegments2(lineGeometry(), lineDepthMaterial(CONSTRAINT_COLOR, CONSTRAINT_LINE_THICKNESS, false)), CONSTRAINT_RENDER_ORDER);
  // "grid" fires on zoom/resize/pan, which move the visible bounds this
  // layer clips against; the dependency check below keeps updates cheap.
  override readonly invalidationKeys = ["constraints", "grid"] as const;

  protected dependencies(): readonly unknown[] {
    const raw = getState();
    const snap = getViewportRenderSnapshot();
    return [
      raw.completionMode,
      raw.highlightIndex,
      raw.polytope,
      raw.is3DMode,
      raw.isTransitioning3D,
      snap.mode,
      snap.orthographic.left,
      snap.orthographic.right,
      snap.orthographic.top,
      snap.orthographic.bottom,
      snap.target.x,
      snap.target.y,
      snap.unitsPerPixel,
      snap.width,
      snap.height,
      snap.scaleFactor,
    ];
  }

  protected rebuild(): void {
    const raw = getState();
    const snap = getViewportRenderSnapshot();

    if (raw.completionMode === "draft" || raw.highlightIndex === null || !raw.polytope || !hasPolytopeLines(raw.polytope) || !shouldRenderSnapshotMode(snap.mode, raw)) {
      this.object3D.visible = false;
      return;
    }

    const line = raw.polytope.lines[raw.highlightIndex];
    if (!line) {
      this.object3D.visible = false;
      return;
    }

    const clipped = clipLineToBounds(line, getVisibleBounds(snap));
    if (!clipped) {
      this.object3D.visible = false;
      return;
    }

    const [start, end] = clipped;
    replaceLinePositions(this.object3D.geometry, [start.x, start.y, 0, end.x, end.y, 0]);

    this.object3D.material = lineDepthMaterial(CONSTRAINT_COLOR, CONSTRAINT_LINE_THICKNESS, snap.mode === "3d");
    this.object3D.visible = true;
  }

  dispose(): void {
    this.object3D.geometry.dispose();
  }
}
