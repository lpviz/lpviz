import { ConeGeometry, Group, Mesh, MeshBasicMaterial } from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { applyHugeBounds, getSharedLineMaterial, replaceLinePositions } from "../helpers/sharedLineMaterials";
import type { SceneContext } from "../SceneContext";
import { LayerBase } from "./base/LayerBase";

const HANDLE_COLOR = "#ff8800";
const LINE_THICKNESS = 4;
const HEAD_LENGTH_PX = 20;
const HEAD_RADIUS_PX = 8;
// resting handle length before the user has dragged any height out
const IDLE_LENGTH_PX = 48;

// The extrude affordance: a vertical arrow rising from the sketched base's
// centroid during the extrude phase. Drawn in the overlay pass without depth
// so it can never hide inside the preview prism.
export class ExtrudeHandleLayer extends LayerBase {
  readonly object3D: Group;
  override readonly renderPass = "overlay" as const;
  override readonly invalidationKeys = ["polytope"] as const;

  private shaftGeo: LineSegmentsGeometry;
  private shaft: LineSegments2;
  private head: Mesh;
  private headGeo: ConeGeometry;

  constructor() {
    super();
    this.shaftGeo = new LineSegmentsGeometry();
    applyHugeBounds(this.shaftGeo);
    this.shaft = new LineSegments2(
      this.shaftGeo,
      getSharedLineMaterial({
        color: HANDLE_COLOR,
        linewidth: LINE_THICKNESS,
        depthTest: false,
        depthWrite: false,
        opacity: 1,
      }),
    );
    this.headGeo = new ConeGeometry(1, 1, 16);
    this.head = new Mesh(
      this.headGeo,
      new MeshBasicMaterial({
        color: HANDLE_COLOR,
        depthTest: false,
        depthWrite: false,
      }),
    );
    for (const obj of [this.shaft, this.head]) {
      obj.frustumCulled = false;
      obj.visible = false;
    }
    const group = new Group();
    group.add(this.shaft, this.head);
    this.object3D = group;
  }

  protected dependencies(ctx: SceneContext): readonly unknown[] {
    const raw = ctx.getState();
    const snap = ctx.getSnapshot();
    return [raw.problemMode, raw.editor3Phase, raw.vertices, raw.extrudePreviewHeight, snap.mode, snap.unitsPerPixel];
  }

  protected rebuild(ctx: SceneContext): void {
    const raw = ctx.getState();
    const snap = ctx.getSnapshot();
    if (raw.problemMode !== "3d" || raw.editor3Phase !== "extrude" || snap.mode !== "3d" || raw.vertices.length === 0) {
      this.shaft.visible = false;
      this.head.visible = false;
      return;
    }

    let cx = 0;
    let cy = 0;
    for (const v of raw.vertices) {
      cx += v.x;
      cy += v.y;
    }
    cx /= raw.vertices.length;
    cy /= raw.vertices.length;

    const idleLength = IDLE_LENGTH_PX * snap.unitsPerPixel;
    const top = Math.max(raw.extrudePreviewHeight ?? 0, idleLength);
    const headLength = HEAD_LENGTH_PX * snap.unitsPerPixel;
    const headRadius = HEAD_RADIUS_PX * snap.unitsPerPixel;

    replaceLinePositions(this.shaftGeo, [cx, cy, 0, cx, cy, Math.max(0, top - headLength)]);
    this.head.scale.set(headRadius, headLength, headRadius);
    // cone's +y axis onto world +z
    this.head.rotation.set(Math.PI / 2, 0, 0);
    this.head.position.set(cx, cy, top - headLength / 2);
    this.shaft.visible = true;
    this.head.visible = true;
  }

  dispose(): void {
    this.shaftGeo.dispose();
    this.headGeo.dispose();
  }
}
