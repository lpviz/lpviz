import { getState, type State } from "@/features/core/store";
import { getViewportRenderSnapshot } from "@/features/viewport/runtime/snapshot";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { type BoundingBox, clipRayToBoundingBox, isConvexChain, VRep } from "@lpviz/math/geometry";
import type { Line, Vec } from "@lpviz/math/types";
import { hasPolytopeLines } from "@lpviz/polytope/polytopeTypes";
import { DoubleSide, Group, Mesh, MeshBasicMaterial, Shape, ShapeGeometry } from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { rendersPlanarDrawing } from "../helpers/sceneVisibility";
import { lineDepthMaterial, lineGeometry, replaceLinePositions, setupLine } from "../helpers/sharedLineMaterials";
import { visibleBounds2D } from "../helpers/visibleBounds";
import type { LayerRenderObject } from "../Layer";
import { LayerBase } from "./base/LayerBase";

const POLYTOPE_FILL_COLOR = "#e6e6e6";
const POLYTOPE_HIGHLIGHT_COLOR = "#ff0000";
const POLYTOPE_OUTLINE_COLOR = "#000000";
const POLY_LINE_THICKNESS = 2;
const DEFAULT_UNBOUNDED_EXTENT = 5000;
const EPS = 1e-10;

const UNBOUNDED_BOUNDS: BoundingBox = {
  minX: -DEFAULT_UNBOUNDED_EXTENT,
  maxX: DEFAULT_UNBOUNDED_EXTENT,
  minY: -DEFAULT_UNBOUNDED_EXTENT,
  maxY: DEFAULT_UNBOUNDED_EXTENT,
};

const fillMaterial = (color: string) =>
  new MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.6,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

function buildShapeFromVertices(vertices: ReadonlyArray<Vec>) {
  const shape = new Shape();
  if (vertices.length === 0) return shape;
  shape.moveTo(vertices[0]![0], vertices[0]![1]);
  for (let i = 1; i < vertices.length; i++) shape.lineTo(vertices[i]![0], vertices[i]![1]);
  shape.closePath();
  return shape;
}

function clipPolygonToHalfPlane(polygon: Vec[], line: Line): Vec[] {
  if (polygon.length === 0) return [];
  const [A, B, C] = line;
  const inside = (p: Vec) => A * p[0] + B * p[1] <= C + EPS;
  const intersect = (s: Vec, e: Vec): Vec => {
    const dx = e[0] - s[0],
      dy = e[1] - s[1];
    const denom = A * dx + B * dy;
    if (Math.abs(denom) < EPS) return e;
    const t = (C - A * s[0] - B * s[1]) / denom;
    return [s[0] + t * dx, s[1] + t * dy];
  };
  const result: Vec[] = [];
  let prev = polygon[polygon.length - 1]!,
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

function clipRegionToBoundingBox(lines: Line[], bounds: BoundingBox): Vec[] {
  let polygon: Vec[] = [
    [bounds.minX, bounds.minY],
    [bounds.maxX, bounds.minY],
    [bounds.maxX, bounds.maxY],
    [bounds.minX, bounds.maxY],
  ];
  for (const line of lines) {
    polygon = clipPolygonToHalfPlane(polygon, line);
    if (polygon.length === 0) return [];
  }
  return polygon;
}

type PolytopeRenderResult = {
  fillVertices: Vec[];
  isNonconvex: boolean;
  normalSegments: number[];
  highlightSegments: number[];
};

function buildPolytopeGeometry(state: State, snap: ViewportRenderSnapshot): PolytopeRenderResult {
  const { vertices, completionMode, highlightIndex, polytope } = state;
  const regionFinished = completionMode !== "draft";
  const hasDerived = completionMode === "open" && polytope?.kind === "bounded" && polytope.vertices.length >= 3;
  const displayVertices: Vec[] = hasDerived && polytope?.kind === "bounded" ? polytope.vertices : vertices;
  const isClosedRegion = completionMode === "closed" || hasDerived;
  // A closed region (or an open one promoted to its derived hull) is a cyclic
  // polygon, so closed-polygon convexity applies. An un-promoted open region is
  // a polyline — testing it as a closed polygon spuriously flags it nonconvex
  // when the wrap-around edge v[n-1]->v[0] turns the other way, which is exactly
  // the validity test computeEditorRegionForState uses (isConvexChain).
  const isNonconvex = isClosedRegion ? !VRep.fromPoints(displayVertices).isConvex() : !isConvexChain(displayVertices);

  // an unbounded open region is clipped to a fixed extent; in 3D so is
  // everything (the visible rect is only meaningful under the ortho camera)
  const bounds = (completionMode === "open" && !hasDerived && polytope?.kind === "unbounded") || snap.mode !== "2d" ? UNBOUNDED_BOUNDS : visibleBounds2D(snap);

  const fillVertices: Vec[] =
    isClosedRegion && displayVertices.length >= 3
      ? displayVertices
      : completionMode === "open" && polytope?.kind === "unbounded" && hasPolytopeLines(polytope)
        ? clipRegionToBoundingBox(polytope.lines, bounds)
        : [];

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
    arr.push(s[0], s[1], 0, e[0], e[1], 0);
  }

  if (completionMode === "open" && !hasDerived && polytope?.boundaryRays) {
    for (const ray of polytope.boundaryRays) {
      const clipped = clipRayToBoundingBox(ray.start, ray.direction, bounds);
      if (!clipped) continue;
      const [s, e] = clipped;
      normalSegments.push(s[0], s[1], 0, e[0], e[1], 0);
    }
  }

  return {
    fillVertices,
    isNonconvex,
    normalSegments,
    highlightSegments,
  };
}

export class PolytopeBaseLayer extends LayerBase {
  readonly object3D: Group;
  readonly renderObjects: readonly LayerRenderObject[];
  override readonly invalidationKeys = ["polytope"] as const;
  private fillMesh: Mesh;
  private fillMatNormal: MeshBasicMaterial;
  private fillMatHighlight: MeshBasicMaterial;
  private normalEdges: LineSegments2;
  private highlightEdges: LineSegments2;

  constructor() {
    super();
    const fMatN = fillMaterial(POLYTOPE_FILL_COLOR);
    const fMatH = fillMaterial(POLYTOPE_HIGHLIGHT_COLOR);
    const mesh = new Mesh(undefined, fMatN);
    mesh.renderOrder = RENDER_ORDER.polytopeFill;
    mesh.frustumCulled = false;
    mesh.visible = false;

    const nEdges = setupLine(new LineSegments2(lineGeometry(), lineDepthMaterial(POLYTOPE_OUTLINE_COLOR, POLY_LINE_THICKNESS, false)), RENDER_ORDER.polyEdges);
    const hEdges = setupLine(new LineSegments2(lineGeometry(), lineDepthMaterial(POLYTOPE_HIGHLIGHT_COLOR, POLY_LINE_THICKNESS, false)), RENDER_ORDER.polyEdges);

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
    this.normalEdges = nEdges;
    this.highlightEdges = hEdges;
  }

  protected dependencies(): readonly unknown[] {
    const raw = getState();
    const snap = getViewportRenderSnapshot();
    return [
      raw.vertices,
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
      snap.unitsPerPixel,
      snap.target.x,
      snap.target.y,
      snap.transitionZMultiplier,
    ];
  }

  protected rebuild(): void {
    const raw = getState();
    const snap = getViewportRenderSnapshot();

    const visible = raw.vertices.length > 0 && rendersPlanarDrawing(snap.mode, raw);
    this.object3D.visible = visible;
    if (!visible) {
      this.fillMesh.visible = false;
      return;
    }

    const is3D = snap.mode === "3d";
    const result = buildPolytopeGeometry(raw, snap);

    if (result.fillVertices.length >= 3) {
      // free the previous fill's GL buffers before the geometry is replaced
      this.fillMesh.geometry.dispose();
      this.fillMesh.geometry = new ShapeGeometry(buildShapeFromVertices(result.fillVertices));
      this.fillMesh.material = result.isNonconvex ? this.fillMatHighlight : this.fillMatNormal;
      this.fillMesh.visible = true;
    } else {
      this.fillMesh.visible = false;
    }

    const edges: [LineSegments2, number[], string][] = [
      [this.normalEdges, result.normalSegments, POLYTOPE_OUTLINE_COLOR],
      [this.highlightEdges, result.highlightSegments, POLYTOPE_HIGHLIGHT_COLOR],
    ];
    for (const [segs, segments, color] of edges) {
      segs.visible = segments.length >= 6;
      if (segs.visible) {
        replaceLinePositions(segs.geometry, segments);
        segs.material = lineDepthMaterial(color, POLY_LINE_THICKNESS, is3D);
      }
    }
  }

  dispose(): void {
    this.normalEdges.geometry.dispose();
    this.highlightEdges.geometry.dispose();
    this.fillMatNormal.dispose();
    this.fillMatHighlight.dispose();
    this.fillMesh.geometry.dispose();
  }
}
