import type { State } from "@/features/core/store";
import type { PointXY } from "@lpviz/math/types";
import { BufferAttribute, Group, Points, PointsMaterial } from "three";
import { makePointsGeo } from "../helpers/makePointsGeo";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { is3DSolidActive, shouldRenderSnapshotMode } from "../helpers/sceneVisibility";
import { SHARED_CIRCLE_TEXTURE, SHARED_SQUARE_TEXTURE } from "../helpers/sharedTextures";
import type { SceneContext } from "../SceneContext";
import { LayerBase } from "./base/LayerBase";

const VERTEX_COLOR = "#ff0000";
const OPEN_ANCHOR_COLOR = "#ff0000";
const VERTEX_PIXEL_SIZE = 10;
const VERTEX_RENDER_ORDER = RENDER_ORDER.polytopeVertices;

function buildVertexPositions(displayVertices: PointXY[], shapeFilter: "circle" | "square", completionMode: State["completionMode"], hasDerivedClosedRegion: boolean): Float32Array {
  const out: number[] = [];
  for (let index = 0; index < displayVertices.length; index++) {
    const v = displayVertices[index]!;
    const isAnchor = completionMode === "open" && !hasDerivedClosedRegion && (index === 0 || index === displayVertices.length - 1);
    const isSquare = isAnchor;
    if (shapeFilter === "square" ? !isSquare : isSquare) continue;
    out.push(v.x, v.y, 0);
  }
  return new Float32Array(out);
}

function applyPositions(pts: Points, positions: Float32Array) {
  // free the old GL buffers before the attribute is replaced
  pts.geometry.dispose();
  pts.geometry.setAttribute("position", new BufferAttribute(positions, 3));
  pts.visible = positions.length > 0;
}

export class PolytopeVerticesLayer extends LayerBase {
  readonly object3D: Group;
  override readonly renderPass = "vertices" as const;
  override readonly invalidationKeys = ["polytope"] as const;
  private circlePoints: Points;
  private squarePoints: Points;

  constructor() {
    super();
    const circleMat = new PointsMaterial({
      color: VERTEX_COLOR,
      size: VERTEX_PIXEL_SIZE,
      sizeAttenuation: false,
      transparent: false,
      depthTest: false,
      depthWrite: false,
      alphaMap: SHARED_CIRCLE_TEXTURE,
      alphaTest: 0.2,
    });
    const squareMat = new PointsMaterial({
      color: OPEN_ANCHOR_COLOR,
      size: VERTEX_PIXEL_SIZE,
      sizeAttenuation: false,
      transparent: false,
      depthTest: false,
      depthWrite: false,
      alphaMap: SHARED_SQUARE_TEXTURE,
      alphaTest: 0.2,
    });
    const cPts = new Points(makePointsGeo(), circleMat);
    cPts.renderOrder = VERTEX_RENDER_ORDER;
    cPts.frustumCulled = false;
    const sPts = new Points(makePointsGeo(), squareMat);
    sPts.renderOrder = VERTEX_RENDER_ORDER;
    sPts.frustumCulled = false;
    const g = new Group();
    g.add(cPts, sPts);
    this.object3D = g;
    this.circlePoints = cPts;
    this.squarePoints = sPts;
  }

  protected dependencies(ctx: SceneContext): readonly unknown[] {
    const raw = ctx.getState();
    return [raw.vertices, raw.completionMode, raw.polytope, raw.problemMode, raw.editor3Phase, ctx.getSnapshot().mode];
  }

  protected rebuild(ctx: SceneContext): void {
    const raw = ctx.getState();
    const snap = ctx.getSnapshot();

    const visible = raw.vertices.length > 0 && shouldRenderSnapshotMode(snap.mode, raw) && !is3DSolidActive(raw);
    this.object3D.visible = visible;
    if (!visible) return;

    const hasDerived = raw.completionMode === "open" && raw.polytope?.kind === "bounded" && (raw.polytope.vertices?.length ?? 0) >= 3;
    const displayVertices: PointXY[] = hasDerived && raw.polytope?.kind === "bounded" ? raw.polytope.vertices.map(([x, y]) => ({ x, y })) : raw.vertices;
    applyPositions(this.circlePoints, buildVertexPositions(displayVertices, "circle", raw.completionMode, hasDerived));
    applyPositions(this.squarePoints, buildVertexPositions(displayVertices, "square", raw.completionMode, hasDerived));
  }

  dispose(): void {
    (this.circlePoints.material as PointsMaterial).dispose();
    (this.squarePoints.material as PointsMaterial).dispose();
    this.circlePoints.geometry.dispose();
    this.squarePoints.geometry.dispose();
  }
}
