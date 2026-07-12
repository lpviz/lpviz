import type { PointXYZ } from "@lpviz/math/types";
import { centroid3 } from "@lpviz/polytope/polytope3";
import { ConeGeometry, Group, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { applyHugeBounds, getSharedLineMaterial, lineDepthMaterial, replaceLinePositions } from "../helpers/sharedLineMaterials";
import type { SceneContext } from "../SceneContext";
import { LayerBase } from "./base/LayerBase";

const OBJECTIVE_COLOR = "#008000";
const DROP_LINE_COLOR = "#8fbc8f";
const LINE_THICKNESS = 3;
const DROP_LINE_THICKNESS = 1.5;
const HEAD_LENGTH_PX = 18;
const HEAD_RADIUS_PX = 6;
const EPSILON = 1e-3;
const UNIT_Y = new Vector3(0, 1, 0);

// The 3-variable objective arrow, anchored at the solid's centroid (anchoring
// is visual only — the vector is the problem's objective): a depth-tested
// fat-line shaft, a cone tip, and a light drop line from the tip to the
// ground plane as a depth cue for the arrow's 3D direction.
export class Objective3DLayer extends LayerBase {
  readonly object3D: Group;
  override readonly renderPass = "foreground" as const;
  override readonly invalidationKeys = ["objective", "polytope"] as const;

  private shaftGeo: LineSegmentsGeometry;
  private shaft: LineSegments2;
  private dropGeo: LineSegmentsGeometry;
  private drop: LineSegments2;
  private head: Mesh;
  private headGeo: ConeGeometry;

  constructor() {
    super();
    this.shaftGeo = new LineSegmentsGeometry();
    applyHugeBounds(this.shaftGeo);
    this.shaft = new LineSegments2(this.shaftGeo, lineDepthMaterial(OBJECTIVE_COLOR, LINE_THICKNESS, true));
    this.dropGeo = new LineSegmentsGeometry();
    applyHugeBounds(this.dropGeo);
    this.drop = new LineSegments2(
      this.dropGeo,
      getSharedLineMaterial({
        color: DROP_LINE_COLOR,
        linewidth: DROP_LINE_THICKNESS,
        depthTest: false,
        depthWrite: false,
        opacity: 0.8,
      }),
    );
    this.headGeo = new ConeGeometry(1, 1, 16);
    this.head = new Mesh(this.headGeo, new MeshBasicMaterial({ color: OBJECTIVE_COLOR }));
    for (const obj of [this.shaft, this.drop, this.head]) {
      obj.frustumCulled = false;
      obj.visible = false;
      obj.renderOrder = RENDER_ORDER.objective;
    }
    this.drop.renderOrder = RENDER_ORDER.objective - 1;
    const group = new Group();
    group.add(this.shaft, this.drop, this.head);
    this.object3D = group;
  }

  protected dependencies(ctx: SceneContext): readonly unknown[] {
    const raw = ctx.getState();
    const snap = ctx.getSnapshot();
    return [raw.problemMode, raw.objectiveHidden, raw.objectiveVector3, raw.currentObjective3, raw.editor3Phase, raw.polytope3, snap.mode, snap.unitsPerPixel];
  }

  protected rebuild(ctx: SceneContext): void {
    const raw = ctx.getState();
    const snap = ctx.getSnapshot();

    const vector: PointXYZ | null = raw.problemMode === "3d" && !raw.objectiveHidden && snap.mode === "3d" ? (raw.objectiveVector3 ?? (raw.editor3Phase === "objective" ? raw.currentObjective3 : null)) : null;
    const length = vector ? Math.hypot(vector.x, vector.y, vector.z) : 0;
    if (!vector || length < EPSILON) {
      this.shaft.visible = false;
      this.drop.visible = false;
      this.head.visible = false;
      return;
    }

    const anchor: PointXYZ = raw.polytope3 && raw.polytope3.kind === "bounded" && raw.polytope3.vertices.length > 0 ? centroid3(raw.polytope3.vertices) : { x: 0, y: 0, z: 0 };
    const headLength = HEAD_LENGTH_PX * snap.unitsPerPixel;
    const headRadius = HEAD_RADIUS_PX * snap.unitsPerPixel;
    const direction = new Vector3(vector.x / length, vector.y / length, vector.z / length);
    // shaft stops where the cone begins
    const shaftEnd = Math.max(0, length - headLength);
    replaceLinePositions(this.shaftGeo, [anchor.x, anchor.y, anchor.z, anchor.x + direction.x * shaftEnd, anchor.y + direction.y * shaftEnd, anchor.z + direction.z * shaftEnd]);

    const tip: PointXYZ = { x: anchor.x + vector.x, y: anchor.y + vector.y, z: anchor.z + vector.z };
    replaceLinePositions(this.dropGeo, [tip.x, tip.y, tip.z, tip.x, tip.y, 0]);

    this.head.scale.set(headRadius, headLength, headRadius);
    this.head.quaternion.copy(new Quaternion().setFromUnitVectors(UNIT_Y, direction));
    this.head.position.set(anchor.x + direction.x * (length - headLength / 2), anchor.y + direction.y * (length - headLength / 2), anchor.z + direction.z * (length - headLength / 2));
    this.shaft.visible = true;
    this.drop.visible = Math.abs(tip.z) > EPSILON;
    this.head.visible = true;
  }

  dispose(): void {
    this.shaftGeo.dispose();
    this.dropGeo.dispose();
    this.headGeo.dispose();
  }
}
