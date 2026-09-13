import { type BoundingBox } from "@lpviz/math/geometry";
import type { Line, PointXY } from "@lpviz/math/types";
import { hasPolytopeLines } from "@lpviz/polytope/polytopeTypes";
import { projectCanvasPointToWorldPlane } from "@lpviz/viewport/transition";
import { Group } from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { is3DSolidActive, shouldRenderSnapshotMode } from "../helpers/sceneVisibility";
import { applyHugeBounds, lineDepthMaterial, replaceLinePositions } from "../helpers/sharedLineMaterials";
import type { SceneContext } from "../SceneContext";
import { LayerBase } from "./base/LayerBase";

const CONSTRAINT_COLOR = "#ff0000";
const CONSTRAINT_RENDER_ORDER = RENDER_ORDER.constraintLines;
const CONSTRAINT_LINE_THICKNESS = 2;
const CLIP_MARGIN_PX = 50;
const CLIP_MARGIN_UNITS = 50;
const DEFAULT_3D_EXTENT = 5000;
const EPS = 1e-10;

const getConstraintMat = (is3D: boolean) => lineDepthMaterial(CONSTRAINT_COLOR, CONSTRAINT_LINE_THICKNESS, is3D);

function getVisibleBounds(snap: ReturnType<SceneContext["getSnapshot"]>): BoundingBox {
  if (snap.mode === "2d") {
    const halfWidth = (snap.orthographic.right - snap.orthographic.left) / 2;
    const halfHeight = (snap.orthographic.top - snap.orthographic.bottom) / 2;
    const marginUnits = CLIP_MARGIN_PX * snap.unitsPerPixel + CLIP_MARGIN_UNITS;
    return {
      minX: snap.target.x - halfWidth - marginUnits,
      maxX: snap.target.x + halfWidth + marginUnits,
      minY: snap.target.y - halfHeight - marginUnits,
      maxY: snap.target.y + halfHeight + marginUnits,
    };
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
  readonly object3D: Group;
  // "grid" fires on zoom/resize/pan, which move the visible bounds this
  // layer clips against; the dependency check below keeps updates cheap.
  override readonly invalidationKeys = ["constraints", "grid"] as const;
  private cGeo: LineSegmentsGeometry;
  private cSegs: LineSegments2;

  constructor() {
    super();
    const cGeo = new LineSegmentsGeometry();
    applyHugeBounds(cGeo);
    const cSegs = new LineSegments2(cGeo, getConstraintMat(false));
    cSegs.renderOrder = CONSTRAINT_RENDER_ORDER;
    cSegs.frustumCulled = false;
    cSegs.visible = false;
    const group = new Group();
    group.add(cSegs);
    this.object3D = group;
    this.cGeo = cGeo;
    this.cSegs = cSegs;
  }

  protected dependencies(ctx: SceneContext): readonly unknown[] {
    const raw = ctx.getState();
    const snap = ctx.getSnapshot();
    return [raw.completionMode, raw.highlightIndex, raw.polytope, raw.is3DMode, raw.isTransitioning3D, raw.problemMode, raw.editor3Phase, snap.mode, snap.orthographic.left, snap.orthographic.right, snap.orthographic.top, snap.orthographic.bottom, snap.target.x, snap.target.y, snap.unitsPerPixel, snap.width, snap.height, snap.scaleFactor];
  }

  protected rebuild(ctx: SceneContext): void {
    const raw = ctx.getState();
    const snap = ctx.getSnapshot();

    if (
      raw.completionMode === "draft" ||
      raw.highlightIndex === null ||
      !raw.polytope ||
      !hasPolytopeLines(raw.polytope) ||
      !shouldRenderSnapshotMode(snap.mode, raw) ||
      // 3-variable solids highlight faces via Polytope3DLayer instead
      is3DSolidActive(raw)
    ) {
      this.cSegs.visible = false;
      return;
    }

    const line = raw.polytope.lines[raw.highlightIndex];
    if (!line) {
      this.cSegs.visible = false;
      return;
    }

    const clipped = clipLineToBounds(line, getVisibleBounds(snap));
    if (!clipped) {
      this.cSegs.visible = false;
      return;
    }

    const [start, end] = clipped;
    replaceLinePositions(this.cGeo, [start.x, start.y, 0, end.x, end.y, 0]);

    this.cSegs.material = getConstraintMat(snap.mode === "3d");
    this.cSegs.visible = true;
  }

  dispose(): void {
    this.cGeo.dispose();
  }
}
