import type { State } from "@/features/core/store";
import { type BoundingBox, isConvexChain, VRep } from "@lpviz/math/geometry";
import type { Line, PointXY } from "@lpviz/math/types";
import { hasPolytopeLines } from "@lpviz/polytope/polytopeTypes";
import { DoubleSide, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, Shape, ShapeGeometry } from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { is3DSolidActive, shouldRenderSnapshotMode } from "../helpers/sceneVisibility";
import { applyHugeBounds, lineDepthMaterial, replaceLinePositions } from "../helpers/sharedLineMaterials";
import type { LayerRenderObject } from "../Layer";
import type { SceneContext } from "../SceneContext";
import { LayerBase } from "./base/LayerBase";

const POLYTOPE_FILL_COLOR = "#e6e6e6";
const POLYTOPE_HIGHLIGHT_COLOR = "#ff0000";
const POLYTOPE_OUTLINE_COLOR = "#000000";
const POLY_LINE_THICKNESS = 2;
const CLIP_MARGIN_PX = 50;
const CLIP_MARGIN_UNITS = 50;
const DEFAULT_UNBOUNDED_EXTENT = 5000;
const EPS = 1e-10;

const getPolytopeEdgeMat = (color: string, is3D: boolean) => lineDepthMaterial(color, POLY_LINE_THICKNESS, is3D);

function buildShapeFromVertices(vertices: ReadonlyArray<PointXY>) {
  const shape = new Shape();
  if (vertices.length === 0) return shape;
  shape.moveTo(vertices[0].x, vertices[0].y);
  for (let i = 1; i < vertices.length; i++) shape.lineTo(vertices[i].x, vertices[i].y);
  shape.closePath();
  return shape;
}

function clipPolygonToHalfPlane(polygon: PointXY[], line: Line): PointXY[] {
  if (polygon.length === 0) return [];
  const [A, B, C] = line;
  const inside = (p: PointXY) => A * p.x + B * p.y <= C + EPS;
  const intersect = (s: PointXY, e: PointXY): PointXY => {
    const dx = e.x - s.x,
      dy = e.y - s.y;
    const denom = A * dx + B * dy;
    if (Math.abs(denom) < EPS) return e;
    const t = (C - A * s.x - B * s.y) / denom;
    return { x: s.x + t * dx, y: s.y + t * dy };
  };
  const result: PointXY[] = [];
  let prev = polygon[polygon.length - 1],
    prevIn = inside(prev);
  for (const cur of polygon) {
    const curIn = inside(cur);
    if (curIn) {
      if (!prevIn) result.push(intersect(prev, cur));
      result.push(cur);
    } else if (prevIn) result.push(intersect(prev, cur));
    prev = cur;
    prevIn = curIn;
  }
  return result;
}

function clipRegionToBoundingBox(lines: Line[], bounds: BoundingBox): PointXY[] {
  let polygon: PointXY[] = [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
  ];
  for (const line of lines) {
    polygon = clipPolygonToHalfPlane(polygon, line);
    if (polygon.length === 0) return [];
  }
  return polygon;
}

function clipRayToBoundingBox(start: PointXY, direction: PointXY, bounds: BoundingBox): [PointXY, PointXY] | null {
  const candidates: Array<{ t: number; point: PointXY }> = [];
  if (Math.abs(direction.x) > EPS) {
    for (const x of [bounds.minX, bounds.maxX]) {
      const t = (x - start.x) / direction.x;
      if (t <= EPS) continue;
      const y = start.y + t * direction.y;
      if (y >= bounds.minY - EPS && y <= bounds.maxY + EPS) candidates.push({ t, point: { x, y } });
    }
  }
  if (Math.abs(direction.y) > EPS) {
    for (const y of [bounds.minY, bounds.maxY]) {
      const t = (y - start.y) / direction.y;
      if (t <= EPS) continue;
      const x = start.x + t * direction.x;
      if (x >= bounds.minX - EPS && x <= bounds.maxX + EPS) candidates.push({ t, point: { x, y } });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.t - a.t);
  return [start, candidates[0].point];
}

function getVisibleBoundingBox(snap: ReturnType<SceneContext["getSnapshot"]>): BoundingBox {
  if (snap.mode !== "2d") {
    return {
      minX: -DEFAULT_UNBOUNDED_EXTENT,
      maxX: DEFAULT_UNBOUNDED_EXTENT,
      minY: -DEFAULT_UNBOUNDED_EXTENT,
      maxY: DEFAULT_UNBOUNDED_EXTENT,
    };
  }
  const hw = (snap.orthographic.right - snap.orthographic.left) / 2;
  const hh = (snap.orthographic.top - snap.orthographic.bottom) / 2;
  const margin = CLIP_MARGIN_PX * snap.unitsPerPixel + CLIP_MARGIN_UNITS;
  return {
    minX: snap.target.x - hw - margin,
    maxX: snap.target.x + hw + margin,
    minY: snap.target.y - hh - margin,
    maxY: snap.target.y + hh + margin,
  };
}

type PolytopeRenderResult = {
  fillVertices: PointXY[];
  isNonconvex: boolean;
  normalSegments: number[];
  highlightSegments: number[];
  mode: ReturnType<SceneContext["getSnapshot"]>["mode"];
};

function buildPolytopeGeometry(state: State, snap: ReturnType<SceneContext["getSnapshot"]>): PolytopeRenderResult | null {
  if (state.vertices.length === 0 || !shouldRenderSnapshotMode(snap.mode, state)) return null;

  const { vertices, completionMode, highlightIndex, polytope } = state;
  const regionFinished = completionMode !== "draft";
  const hasDerived = completionMode === "open" && polytope?.kind === "bounded" && polytope.vertices.length >= 3;
  const displayVertices: PointXY[] = hasDerived && polytope?.kind === "bounded" ? polytope.vertices.map(([x, y]) => ({ x, y })) : vertices;
  const isClosedRegion = completionMode === "closed" || hasDerived;
  // A closed region (or an open one promoted to its derived hull) is a cyclic
  // polygon, so closed-polygon convexity applies. An un-promoted open region is
  // a polyline — testing it as a closed polygon spuriously flags it nonconvex
  // when the wrap-around edge v[n-1]->v[0] turns the other way, which is exactly
  // the validity test computeEditorRegionForState uses (isConvexChain).
  const isNonconvex = isClosedRegion ? !VRep.fromPoints(displayVertices).isConvex() : !isConvexChain(displayVertices);

  const bounds: BoundingBox =
    completionMode === "open" && !hasDerived && polytope?.kind === "unbounded"
      ? {
          minX: -DEFAULT_UNBOUNDED_EXTENT,
          maxX: DEFAULT_UNBOUNDED_EXTENT,
          minY: -DEFAULT_UNBOUNDED_EXTENT,
          maxY: DEFAULT_UNBOUNDED_EXTENT,
        }
      : getVisibleBoundingBox(snap);

  const fillVertices: PointXY[] = isClosedRegion && displayVertices.length >= 3 ? displayVertices : completionMode === "open" && polytope?.kind === "unbounded" && hasPolytopeLines(polytope) ? clipRegionToBoundingBox(polytope.lines, bounds) : [];

  const normalSegments: number[] = [];
  const highlightSegments: number[] = [];

  const edgeCount = regionFinished ? Math.max(0, displayVertices.length - (isClosedRegion ? 0 : 1)) : Math.max(0, displayVertices.length - 1);
  for (let i = 0; i < edgeCount; i++) {
    const ni = (i + 1) % displayVertices.length;
    if (!isClosedRegion && ni >= displayVertices.length) break;
    const s = displayVertices[i]!;
    const e = displayVertices[ni]!;
    const highlighted = !hasDerived && highlightIndex === i;
    const arr = highlighted ? highlightSegments : normalSegments;
    arr.push(s.x, s.y, 0, e.x, e.y, 0);
  }

  if (completionMode === "open" && !hasDerived && polytope?.boundaryRays) {
    for (const ray of polytope.boundaryRays) {
      const clipped = clipRayToBoundingBox({ x: ray.start[0], y: ray.start[1] }, { x: ray.direction[0], y: ray.direction[1] }, bounds);
      if (!clipped) continue;
      const [s, e] = clipped;
      normalSegments.push(s.x, s.y, 0, e.x, e.y, 0);
    }
  }

  return {
    fillVertices,
    isNonconvex,
    normalSegments,
    highlightSegments,
    mode: snap.mode,
  };
}

function applySegmentsGeometry(geo: LineSegmentsGeometry, segments: number[]) {
  if (segments.length < 6) return false;
  replaceLinePositions(geo, segments);
  return true;
}

export class PolytopeBaseLayer extends LayerBase {
  readonly object3D: Group;
  readonly renderObjects: readonly LayerRenderObject[];
  override readonly invalidationKeys = ["polytope"] as const;
  private fillMesh: Mesh;
  private fillMatNormal: MeshBasicMaterial;
  private fillMatHighlight: MeshBasicMaterial;
  private normalEdgesGeo: LineSegmentsGeometry;
  private normalEdges: LineSegments2;
  private highlightEdgesGeo: LineSegmentsGeometry;
  private highlightEdges: LineSegments2;
  private prevFillGeo: ShapeGeometry | null = null;

  constructor() {
    super();
    const fMatN = new MeshBasicMaterial({
      color: POLYTOPE_FILL_COLOR,
      transparent: true,
      opacity: 0.6,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const fMatH = new MeshBasicMaterial({
      color: POLYTOPE_HIGHLIGHT_COLOR,
      transparent: true,
      opacity: 0.6,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const mesh = new Mesh(undefined, fMatN);
    mesh.renderOrder = RENDER_ORDER.polytopeFill;
    mesh.frustumCulled = false;
    mesh.visible = false;

    const nGeo = new LineSegmentsGeometry();
    applyHugeBounds(nGeo);
    const nEdges = new LineSegments2(nGeo, getPolytopeEdgeMat(POLYTOPE_OUTLINE_COLOR, false));
    nEdges.frustumCulled = false;
    nEdges.renderOrder = RENDER_ORDER.polyEdges;
    nEdges.computeLineDistances = () => nEdges;
    nEdges.visible = false;

    const hGeo = new LineSegmentsGeometry();
    applyHugeBounds(hGeo);
    const hEdges = new LineSegments2(hGeo, getPolytopeEdgeMat(POLYTOPE_HIGHLIGHT_COLOR, false));
    hEdges.frustumCulled = false;
    hEdges.renderOrder = RENDER_ORDER.polyEdges;
    hEdges.computeLineDistances = () => hEdges;
    hEdges.visible = false;

    const edgeGroup = new Group();
    edgeGroup.add(nEdges, hEdges);
    this.object3D = edgeGroup;
    this.renderObjects = [
      { object3D: mesh, pass: "transparent" },
      { object3D: edgeGroup, pass: "foreground" },
    ];
    this.fillMesh = mesh;
    this.fillMatNormal = fMatN;
    this.fillMatHighlight = fMatH;
    this.normalEdgesGeo = nGeo;
    this.normalEdges = nEdges;
    this.highlightEdgesGeo = hGeo;
    this.highlightEdges = hEdges;
  }

  protected dependencies(ctx: SceneContext): readonly unknown[] {
    const raw = ctx.getState();
    const snap = ctx.getSnapshot();
    return [raw.vertices, raw.completionMode, raw.highlightIndex, raw.polytope, raw.is3DMode, raw.isTransitioning3D, raw.problemMode, raw.editor3Phase, snap.mode, snap.orthographic.left, snap.orthographic.right, snap.orthographic.top, snap.orthographic.bottom, snap.unitsPerPixel, snap.target.x, snap.target.y, snap.transitionZMultiplier];
  }

  protected rebuild(ctx: SceneContext): void {
    const raw = ctx.getState();
    const snap = ctx.getSnapshot();

    const visible = raw.vertices.length > 0 && shouldRenderSnapshotMode(snap.mode, raw) && !is3DSolidActive(raw);
    this.object3D.visible = visible;
    if (!visible) {
      this.fillMesh.visible = false;
      return;
    }

    const is3D = snap.mode === "3d";
    this.fillMesh.position.set(0, 0, 0);

    const result = buildPolytopeGeometry(raw, snap);

    if (!result) {
      this.object3D.visible = false;
      this.fillMesh.visible = false;
      return;
    }

    if (result.fillVertices.length >= 3) {
      const newFillGeo = new ShapeGeometry(buildShapeFromVertices(result.fillVertices));
      if (is3D) {
        const pos = newFillGeo.getAttribute("position") as Float32BufferAttribute;
        for (let i = 0; i < pos.count; i++) {
          pos.setZ(i, 0);
        }
        pos.needsUpdate = true;
        newFillGeo.computeBoundingBox();
        newFillGeo.computeBoundingSphere();
      }
      if (this.prevFillGeo) this.prevFillGeo.dispose();
      this.prevFillGeo = newFillGeo;
      this.fillMesh.geometry = newFillGeo;
      this.fillMesh.material = result.isNonconvex ? this.fillMatHighlight : this.fillMatNormal;
      this.fillMesh.visible = true;
    } else {
      this.fillMesh.visible = false;
    }

    if (result.normalSegments.length >= 6) {
      applySegmentsGeometry(this.normalEdgesGeo, result.normalSegments);
      this.normalEdges.material = getPolytopeEdgeMat(POLYTOPE_OUTLINE_COLOR, is3D);
      this.normalEdges.visible = true;
    } else {
      this.normalEdges.visible = false;
    }

    if (result.highlightSegments.length >= 6) {
      applySegmentsGeometry(this.highlightEdgesGeo, result.highlightSegments);
      this.highlightEdges.material = getPolytopeEdgeMat(POLYTOPE_HIGHLIGHT_COLOR, is3D);
      this.highlightEdges.visible = true;
    } else {
      this.highlightEdges.visible = false;
    }
  }

  dispose(): void {
    this.normalEdgesGeo.dispose();
    this.highlightEdgesGeo.dispose();
    this.fillMatNormal.dispose();
    this.fillMatHighlight.dispose();
    this.prevFillGeo?.dispose();
  }
}
