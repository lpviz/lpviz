import type { State } from "@/features/core/store";
import type { PointXYZ } from "@lpviz/math/types";
import { buildPrismPlanes, derivePolytope3, type Polytope3Representation } from "@lpviz/polytope/polytope3";
import { BufferAttribute, BufferGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, Points, PointsMaterial } from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { LayerRenderObject } from "../Layer";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { applyHugeBounds, lineDepthMaterial, replaceLinePositions } from "../helpers/sharedLineMaterials";
import { SHARED_CIRCLE_TEXTURE } from "../helpers/sharedTextures";
import type { SceneContext } from "../SceneContext";
import { LayerBase } from "./base/LayerBase";

const FACE_COLOR = "#8a9bb8";
// canvas hover (an editing affordance) is blue; red is reserved for the
// problem-panel row highlight, matching the 2D constraint highlight
const FACE_HOVER_COLOR = "#3b82d0";
const FACE_HIGHLIGHT_COLOR = "#ff0000";
const FACE_OPACITY = 0.28;
const FACE_HIGHLIGHT_OPACITY = 0.45;
const EDGE_COLOR = "#000000";
const EDGE_DIM_COLOR = "#b5b5b5";
const EDGE_THICKNESS = 2;
const EDGE_DIM_THICKNESS = 1.5;
const VERTEX_COLOR = "#ff0000";
const VERTEX_DIM_COLOR = "#f2b0b0";
const VERTEX_PIXEL_SIZE = 10;
const MIN_PREVIEW_HEIGHT = 0.05;
// camera strictly outside a face's plane sees that face
const FRONT_FACING_EPSILON = 1e-9;

// The solid being edited/solved in 3-variable mode: translucent depth-tested
// faces + fat-line edges + corner sprites. During the extrude phase it renders
// a live prism preview derived from the sketched base; afterwards it renders
// state.polytope3 (the 2D base layers hide themselves then — see
// PolytopeBaseLayer/PolytopeVerticesLayer solid-active early-outs).
//
// Depth cue: edges and vertices on the far side of the body render dimmed.
// The body is convex, so visibility is exact and cheap on the CPU — a face is
// front-facing iff the camera is outside its plane, an edge is visible iff
// either adjacent face is, and a vertex iff any face it lies on is. That
// avoids any depth-prepass (which would also occlude the iterate paths
// *inside* the body).
export class Polytope3DLayer extends LayerBase {
  readonly object3D: Group;
  readonly renderObjects: readonly LayerRenderObject[];
  // "grid" fires on camera orbit/pan/zoom, which changes which faces are
  // front-facing (same trick as ConstraintHighlightLayer)
  override readonly invalidationKeys = ["polytope", "constraints", "grid"] as const;

  private faceMesh: Mesh;
  private faceGeo: BufferGeometry;
  private highlightMesh: Mesh;
  private highlightGeo: BufferGeometry;
  private edgeSegs: LineSegments2;
  private edgeGeo: LineSegmentsGeometry;
  private edgeSegsDim: LineSegments2;
  private edgeGeoDim: LineSegmentsGeometry;
  private vertexPoints: Points;
  private vertexPointsDim: Points;

  constructor() {
    super();
    this.faceGeo = new BufferGeometry();
    this.faceMesh = new Mesh(
      this.faceGeo,
      new MeshBasicMaterial({
        color: FACE_COLOR,
        transparent: true,
        opacity: FACE_OPACITY,
        side: DoubleSide,
        depthTest: true,
        depthWrite: false,
      }),
    );
    this.highlightGeo = new BufferGeometry();
    this.highlightMesh = new Mesh(
      this.highlightGeo,
      new MeshBasicMaterial({
        color: FACE_HIGHLIGHT_COLOR,
        transparent: true,
        opacity: FACE_HIGHLIGHT_OPACITY,
        side: DoubleSide,
        depthTest: true,
        depthWrite: false,
      }),
    );
    this.edgeGeo = new LineSegmentsGeometry();
    applyHugeBounds(this.edgeGeo);
    this.edgeSegs = new LineSegments2(this.edgeGeo, lineDepthMaterial(EDGE_COLOR, EDGE_THICKNESS, true));
    this.edgeGeoDim = new LineSegmentsGeometry();
    applyHugeBounds(this.edgeGeoDim);
    this.edgeSegsDim = new LineSegments2(this.edgeGeoDim, lineDepthMaterial(EDGE_DIM_COLOR, EDGE_DIM_THICKNESS, true));
    this.vertexPoints = new Points(new BufferGeometry(), makeVertexMaterial(VERTEX_COLOR));
    this.vertexPointsDim = new Points(new BufferGeometry(), makeVertexMaterial(VERTEX_DIM_COLOR));

    for (const obj of [this.faceMesh, this.highlightMesh, this.edgeSegs, this.edgeSegsDim, this.vertexPoints, this.vertexPointsDim]) {
      obj.frustumCulled = false;
      obj.visible = false;
    }
    this.faceMesh.renderOrder = RENDER_ORDER.polytopeFill;
    this.highlightMesh.renderOrder = RENDER_ORDER.polytopeFill + 1;
    this.edgeSegsDim.renderOrder = RENDER_ORDER.polyEdges - 1;
    this.edgeSegs.renderOrder = RENDER_ORDER.polyEdges;
    this.vertexPointsDim.renderOrder = RENDER_ORDER.polytopeVertices - 1;
    this.vertexPoints.renderOrder = RENDER_ORDER.polytopeVertices;

    const faceGroup = new Group();
    faceGroup.add(this.faceMesh, this.highlightMesh);
    const edgeGroup = new Group();
    edgeGroup.add(this.edgeSegsDim, this.edgeSegs);
    const vertexGroup = new Group();
    vertexGroup.add(this.vertexPointsDim, this.vertexPoints);
    this.object3D = faceGroup;
    this.renderObjects = [
      { object3D: faceGroup, pass: "transparent" },
      { object3D: edgeGroup, pass: "foreground" },
      { object3D: vertexGroup, pass: "vertices" },
    ];
  }

  protected dependencies(ctx: SceneContext): readonly unknown[] {
    const raw = ctx.getState();
    const snap = ctx.getSnapshot();
    return [
      raw.problemMode,
      raw.editor3Phase,
      raw.polytope3,
      raw.polytope,
      raw.extrudePreviewHeight,
      raw.hoveredFaceIndex,
      raw.highlightIndex,
      snap.mode,
      // visibility classification follows the camera
      snap.perspective.position.x,
      snap.perspective.position.y,
      snap.perspective.position.z,
    ];
  }

  protected rebuild(ctx: SceneContext): void {
    const raw = ctx.getState();
    const rep = this.representationFor(raw);
    if (raw.problemMode !== "3d" || ctx.getSnapshot().mode !== "3d" || !rep || rep.kind !== "bounded") {
      this.setVisible(false);
      return;
    }
    const camera = ctx.getSnapshot().perspective.position;

    const hoverFace = raw.editor3Phase === "extrude" ? null : raw.hoveredFaceIndex;
    const panelFace = raw.editor3Phase === "extrude" ? null : raw.highlightIndex;
    const highlightedFace = hoverFace ?? panelFace;
    (this.highlightMesh.material as MeshBasicMaterial).color.set(hoverFace !== null ? FACE_HOVER_COLOR : FACE_HIGHLIGHT_COLOR);

    const faceFront = rep.faces.map((face) => {
      const plane = rep.planes[face.planeIndex]!;
      return plane[0]! * camera.x + plane[1]! * camera.y + plane[2]! * camera.z > plane[3]! + FRONT_FACING_EPSILON;
    });

    const facePositions: number[] = [];
    const highlightPositions: number[] = [];
    // undirected edge -> is any adjacent face front-facing
    const edgeVisible = new Map<string, { a: PointXYZ; b: PointXYZ; front: boolean }>();
    const vertexBright = new Array<boolean>(rep.vertices.length).fill(false);

    rep.faces.forEach((face, faceIndex) => {
      const target = face.planeIndex === highlightedFace ? highlightPositions : facePositions;
      const ring = face.vertexIndices;
      const front = faceFront[faceIndex]!;
      for (let i = 1; i + 1 < ring.length; i++) {
        pushVertex(target, rep.vertices[ring[0]!]!);
        pushVertex(target, rep.vertices[ring[i]!]!);
        pushVertex(target, rep.vertices[ring[i + 1]!]!);
      }
      for (let i = 0; i < ring.length; i++) {
        const ai = ring[i]!;
        const bi = ring[(i + 1) % ring.length]!;
        if (front) vertexBright[ai] = true;
        const key = ai < bi ? `${ai}:${bi}` : `${bi}:${ai}`;
        const entry = edgeVisible.get(key);
        if (entry) entry.front = entry.front || front;
        else edgeVisible.set(key, { a: rep.vertices[ai]!, b: rep.vertices[bi]!, front });
      }
    });

    // handles not on any ring (inserted on a face, or absorbed inside the
    // hull): bright while their supporting face is front-facing
    for (let i = 0; i < rep.vertices.length; i++) {
      if (vertexBright[i]) continue;
      const v = rep.vertices[i]!;
      for (let f = 0; f < rep.faces.length; f++) {
        if (!faceFront[f]) continue;
        const plane = rep.planes[rep.faces[f]!.planeIndex]!;
        if (Math.abs(plane[0]! * v.x + plane[1]! * v.y + plane[2]! * v.z - plane[3]!) < 1e-7 * (1 + Math.abs(plane[3]!))) {
          vertexBright[i] = true;
          break;
        }
      }
    }

    const edgePositions: number[] = [];
    const edgePositionsDim: number[] = [];
    for (const { a, b, front } of edgeVisible.values()) {
      (front ? edgePositions : edgePositionsDim).push(a.x, a.y, a.z, b.x, b.y, b.z);
    }

    replaceMeshPositions(this.faceMesh, this.faceGeo, facePositions);
    replaceMeshPositions(this.highlightMesh, this.highlightGeo, highlightPositions);
    replaceLinePositions(this.edgeGeo, edgePositions);
    this.edgeSegs.visible = edgePositions.length > 0;
    replaceLinePositions(this.edgeGeoDim, edgePositionsDim);
    this.edgeSegsDim.visible = edgePositionsDim.length > 0;

    const bright: number[] = [];
    const dim: number[] = [];
    for (let i = 0; i < rep.vertices.length; i++) {
      pushVertex(vertexBright[i] ? bright : dim, rep.vertices[i]!);
    }
    replacePointPositions(this.vertexPoints, bright);
    replacePointPositions(this.vertexPointsDim, dim);
  }

  private representationFor(raw: State): Polytope3Representation | null {
    if (raw.editor3Phase === "extrude") {
      const baseLines = raw.polytope?.lines;
      if (!baseLines || baseLines.length < 3) return null;
      const height = Math.max(raw.extrudePreviewHeight ?? 0, MIN_PREVIEW_HEIGHT);
      return derivePolytope3(buildPrismPlanes(baseLines, height));
    }
    return raw.polytope3;
  }

  private setVisible(visible: boolean): void {
    this.faceMesh.visible = visible;
    this.highlightMesh.visible = visible;
    this.edgeSegs.visible = visible;
    this.edgeSegsDim.visible = visible;
    this.vertexPoints.visible = visible;
    this.vertexPointsDim.visible = visible;
  }

  dispose(): void {
    this.faceGeo.dispose();
    this.highlightGeo.dispose();
    this.edgeGeo.dispose();
    this.edgeGeoDim.dispose();
    this.vertexPoints.geometry.dispose();
    this.vertexPointsDim.geometry.dispose();
  }
}

function makeVertexMaterial(color: string): PointsMaterial {
  return new PointsMaterial({
    color,
    size: VERTEX_PIXEL_SIZE,
    sizeAttenuation: false,
    map: SHARED_CIRCLE_TEXTURE,
    alphaTest: 0.5,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
}

function pushVertex(target: number[], v: PointXYZ): void {
  target.push(v.x, v.y, v.z);
}

function replaceMeshPositions(mesh: Mesh, geo: BufferGeometry, positions: number[]): void {
  geo.dispose();
  geo.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  mesh.visible = positions.length > 0;
}

function replacePointPositions(points: Points, positions: number[]): void {
  points.geometry.dispose();
  points.geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  points.visible = positions.length > 0;
}
