import type { State } from "@/features/core/store";
import { derivedClosure } from "@/features/problem/selectors";
import { UNBOUNDED_CLIP_BOUNDS, visibleBounds2D, visibleBoundsDeps } from "@/features/viewport/bounds";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { clipHalfPlanesToBoundingBox, clipRayToBoundingBox } from "@lpviz/math/bounds";
import { isConvexChain, isConvexPolygon } from "@lpviz/math/polygon";
import type { Vec } from "@lpviz/math/types";
import { hasConstraints } from "@lpviz/polytope/polytope";
import { DoubleSide, Group, Mesh, MeshBasicMaterial, Shape, ShapeGeometry } from "three";
import { FatLine } from "../helpers/fatLine";
import { rendersPlanarDrawing } from "../helpers/sceneVisibility";
import { type LayerPlacement, passOf, renderOrderOf } from "../Layer";
import { PALETTE, STROKE } from "../palette";
import { LayerBase } from "./base/LayerBase";

const translucentFill = (color: string) =>
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

type PolytopeRenderResult = {
  fillVertices: Vec[];
  isNonconvex: boolean;
  normalSegments: number[];
  highlightSegments: number[];
};

function buildPolytopeGeometry(state: State, snap: ViewportRenderSnapshot): PolytopeRenderResult {
  const { completionMode, highlightIndex, polytope } = state;
  const derived = derivedClosure(state);
  const hasDerived = derived !== null;
  const displayVertices: Vec[] = derived ?? state.vertices;
  const isClosedRegion = completionMode === "closed" || hasDerived;
  // A closed region (or an open one promoted to its derived hull) is a cyclic
  // polygon, so closed-polygon convexity applies. An un-promoted open region is
  // a polyline — testing it as a closed polygon spuriously flags it nonconvex
  // when the wrap-around edge v[n-1]->v[0] turns the other way, which is exactly
  // the validity test computeEditorRegionForState uses (isConvexChain).
  const isNonconvex = isClosedRegion ? !isConvexPolygon(displayVertices) : !isConvexChain(displayVertices);

  // an unbounded open region is clipped to a fixed extent; in 3D so is
  // everything (the visible rect is only meaningful under the ortho camera)
  const bounds = (completionMode === "open" && !hasDerived && polytope?.kind === "unbounded") || snap.mode !== "2d" ? UNBOUNDED_CLIP_BOUNDS : visibleBounds2D(snap);

  const fillVertices: Vec[] =
    isClosedRegion && displayVertices.length >= 3
      ? displayVertices
      : completionMode === "open" && polytope?.kind === "unbounded" && hasConstraints(polytope)
        ? clipHalfPlanesToBoundingBox(polytope.constraints, bounds)
        : [];

  const normalSegments: number[] = [];
  const highlightSegments: number[] = [];

  // a closed polygon has as many edges as vertices; a draft or an open chain one fewer
  const edgeCount = Math.max(0, displayVertices.length - (isClosedRegion ? 0 : 1));
  for (let i = 0; i < edgeCount; i++) {
    const ni = (i + 1) % displayVertices.length;
    const s = displayVertices[i]!;
    const e = displayVertices[ni]!;
    const highlighted = !hasDerived && highlightIndex === i;
    const arr = highlighted ? highlightSegments : normalSegments;
    arr.push(s[0], s[1], 0, e[0], e[1], 0);
  }

  if (completionMode === "open" && !hasDerived && polytope?.boundaryRays) {
    for (const ray of polytope.boundaryRays) {
      const clipped = clipRayToBoundingBox(ray, bounds);
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
  readonly object3D = new Group();
  readonly slot = "polytopeEdges" as const;
  override readonly invalidationKeys = ["polytope"] as const;
  private readonly fillMaterial = translucentFill(PALETTE.polytopeFill);
  // a nonconvex drawing is filled in the accent colour, so the rejection is visible
  private readonly nonconvexFillMaterial = translucentFill(PALETTE.accent);
  private readonly fillMesh = new Mesh(undefined, this.fillMaterial);
  private readonly normalEdges = new FatLine({ color: PALETTE.polytopeOutline, linewidth: STROKE.polytopeEdge, slot: this.slot });
  private readonly highlightEdges = new FatLine({ color: PALETTE.accent, linewidth: STROKE.polytopeEdge, slot: this.slot });

  constructor() {
    super();
    this.fillMesh.renderOrder = renderOrderOf.polytopeFill;
    this.fillMesh.frustumCulled = false;
    this.fillMesh.visible = false;
    this.object3D.add(this.normalEdges.object3D, this.highlightEdges.object3D);
  }

  // the fill renders in the transparent pass, under everything drawn on the floor; the edges above it
  override placements(): readonly LayerPlacement[] {
    return [
      { object3D: this.fillMesh, pass: passOf.polytopeFill },
      { object3D: this.object3D, pass: passOf[this.slot] },
    ];
  }

  protected dependencies(state: State, snap: ViewportRenderSnapshot): readonly unknown[] {
    return [state.vertices, state.completionMode, state.highlightIndex, state.polytope, ...visibleBoundsDeps(snap)];
  }

  protected override visibleIn(state: State, snap: ViewportRenderSnapshot): boolean {
    return state.vertices.length > 0 && rendersPlanarDrawing(state, snap);
  }

  protected override hide(): void {
    super.hide();
    this.fillMesh.visible = false;
  }

  protected rebuild(state: State, snap: ViewportRenderSnapshot): void {
    const is3D = snap.mode === "3d";
    const result = buildPolytopeGeometry(state, snap);

    if (result.fillVertices.length >= 3) {
      // free the previous fill's GL buffers before the geometry is replaced
      this.fillMesh.geometry.dispose();
      this.fillMesh.geometry = new ShapeGeometry(buildShapeFromVertices(result.fillVertices));
      this.fillMesh.material = result.isNonconvex ? this.nonconvexFillMaterial : this.fillMaterial;
      this.fillMesh.visible = true;
    } else {
      this.fillMesh.visible = false;
    }

    for (const [line, segments] of [
      [this.normalEdges, result.normalSegments],
      [this.highlightEdges, result.highlightSegments],
    ] as const) {
      if (segments.length >= 6) line.draw(segments, is3D);
      else line.hide();
    }
  }

  dispose(): void {
    this.normalEdges.dispose();
    this.highlightEdges.dispose();
    this.fillMaterial.dispose();
    this.nonconvexFillMaterial.dispose();
    this.fillMesh.geometry.dispose();
  }
}
