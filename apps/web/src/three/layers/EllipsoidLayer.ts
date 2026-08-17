import type { EllipsoidPath, LocalizingSetPath } from "@/features/core/store";
import { Group, Matrix4 } from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { flatPointXYZ } from "../helpers/flatPositions";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { shouldRenderSnapshotMode } from "../helpers/sceneVisibility";
import {
  applyHugeBounds,
  lineDepthMaterial,
  replaceLinePositions,
} from "../helpers/sharedLineMaterials";
import type { SceneContext } from "../SceneContext";
import { LayerBase } from "./base/LayerBase";

const ELLIPSOID_COLOR = "#377eb8";
const ACTIVE_THICKNESS = 2.5;
const TRAIL_THICKNESS = 1.5;
// The localizing polyhedron is the region actually still under consideration.
// Thinner and fainter than the ellipse it accompanies — enough to read as a
// boundary, not enough to compete with the path.
const POLYGON_THICKNESS = 1.25;
const POLYGON_OPACITY = 0.7;
const ACTIVE_OPACITY = 0.95;
// Only a mild fade with age: each ellipsoid is ~77% the area of the one before,
// so the older ones are also the *larger* ones — the ones that frame the whole
// picture. Fading them out the way a motion trail would erases exactly what is
// worth seeing.
const OLDEST_OPACITY = 0.45;
// How many of the run's ellipsoids are drawn at once. They are sampled evenly
// across everything computed so far rather than taken from the tail: each one
// is ~77% the area of its predecessor, so an even spread shows the whole
// shrinking sequence (including the initial ellipsoid framing the region)
// instead of a cluster of near-identical ellipses around the optimum.
const TRAIL_COUNT = 10;
const CIRCLE_SEGMENTS = 96;

// Unit circle as segment pairs, shared by every slot: each ellipse is this
// circle under the linear map L with L Lᵀ = P (a Cholesky factor — any square
// root works, since the circle is rotation invariant), so a rebuild only writes
// 10 matrices instead of 10 geometries.
function buildUnitCirclePositions(): Float32Array {
  const positions = new Float32Array(CIRCLE_SEGMENTS * 6);
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
    const bAngle = ((i + 1) / CIRCLE_SEGMENTS) * Math.PI * 2;
    const base = i * 6;
    positions[base] = Math.cos(a);
    positions[base + 1] = Math.sin(a);
    positions[base + 2] = 0;
    positions[base + 3] = Math.cos(bAngle);
    positions[base + 4] = Math.sin(bAngle);
    positions[base + 5] = 0;
  }
  return positions;
}

// Evenly spaced indices in [0, active], newest last, without duplicates.
function sampleIndices(active: number, out: number[]): void {
  out.length = 0;
  if (active <= 0) {
    out.push(0);
    return;
  }
  const wanted = Math.min(TRAIL_COUNT, active + 1);
  for (let j = 0; j < wanted; j++) {
    const index = Math.round((active * j) / (wanted - 1));
    if (out[out.length - 1] !== index) out.push(index);
  }
}

// The lower-triangular Cholesky factor of the 2x2 shape matrix, written into
// `matrix` together with the center and the height `z` of the matching iterate
// (so in 3D each ellipse sits at its own iterate rather than flat on the
// floor). Returns false when P is not (numerically) positive definite, in which
// case the ellipse is skipped rather than drawn with a NaN transform.
function writeEllipseMatrix(
  matrix: Matrix4,
  ellipsoids: EllipsoidPath,
  index: number,
  z: number,
): boolean {
  const base = index * ellipsoids.stride;
  const cx = ellipsoids.data[base]!;
  const cy = ellipsoids.data[base + 1]!;
  const p11 = ellipsoids.data[base + 2]!;
  const p12 = ellipsoids.data[base + 3]!;
  const p22 = ellipsoids.data[base + 4]!;

  if (!(p11 > 0)) return false;
  const l11 = Math.sqrt(p11);
  const l21 = p12 / l11;
  const inner = p22 - l21 * l21;
  if (!(inner > 0)) return false;
  const l22 = Math.sqrt(inner);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return false;

  // prettier-ignore
  matrix.set(
    l11, 0,   0, cx,
    l21, l22, 0, cy,
    0,   0,   1, z,
    0,   0,   0, 1,
  );
  return true;
}

// The ellipsoid method's shrinking ellipsoids, drawn under the iterate path.
// Each ellipse contains every feasible point at least as good as the incumbent
// at that iteration, so watching them nest is watching the method localize the
// optimum. Follows the active iterate: the last one solved, or the one being
// hovered in the log / replayed.
export class EllipsoidLayer extends LayerBase {
  readonly object3D: Group;
  override readonly renderPass = "trace" as const;
  override readonly invalidationKeys = ["iterate"] as const;
  private readonly geometry: LineSegmentsGeometry;
  private readonly slots: LineSegments2[] = [];
  private readonly polygonGeometry: LineSegmentsGeometry;
  private readonly polygon: LineSegments2;
  private readonly matrix = new Matrix4();
  private readonly indices: number[] = [];
  private polygonScratch = new Float32Array(0);

  constructor() {
    super();
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(buildUnitCirclePositions());
    applyHugeBounds(geometry);
    this.geometry = geometry;

    const group = new Group();
    this.polygonGeometry = new LineSegmentsGeometry();
    applyHugeBounds(this.polygonGeometry);
    this.polygon = new LineSegments2(this.polygonGeometry, polygonMaterial(false));
    this.polygon.renderOrder = RENDER_ORDER.ellipsoid;
    this.polygon.frustumCulled = false;
    this.polygon.visible = false;
    group.add(this.polygon);

    for (let slot = 0; slot < TRAIL_COUNT; slot++) {
      const segments = new LineSegments2(geometry, slotMaterial(slot, false));
      segments.renderOrder = RENDER_ORDER.ellipsoid;
      segments.frustumCulled = false;
      segments.matrixAutoUpdate = false;
      segments.visible = false;
      this.slots.push(segments);
      group.add(segments);
    }
    this.object3D = group;
  }

  protected override everyFrame(ctx: SceneContext): void {
    // raw z is baked into each ellipse's transform; zScale and the 2D/3D
    // transition flatten ride on scale.z, exactly as for the iterate path
    this.applyZScale(ctx);
  }

  protected dependencies(ctx: SceneContext): readonly unknown[] {
    const raw = ctx.getState();
    return [
      raw.iterateEllipsoids,
      raw.iterateLocalizingSets,
      raw.iteratePath,
      raw.iterateObjectiveVector,
      raw.highlightIteratePathIndex,
      raw.is3DMode,
      raw.isTransitioning3D,
      ctx.getSnapshot().mode,
    ];
  }

  protected rebuild(ctx: SceneContext): void {
    const raw = ctx.getState();
    const snap = ctx.getSnapshot();
    const ellipsoids = raw.iterateEllipsoids;

    if (
      !ellipsoids ||
      ellipsoids.count === 0 ||
      !shouldRenderSnapshotMode(snap.mode, raw)
    ) {
      this.hideFrom(0);
      return;
    }

    // the replayed prefix, or the hovered row, bounds how much has "happened"
    const revealed =
      raw.iteratePath.count > 0
        ? Math.min(raw.iteratePath.count, ellipsoids.count)
        : ellipsoids.count;
    const active = Math.min(
      raw.highlightIteratePathIndex ?? revealed - 1,
      ellipsoids.count - 1,
    );
    if (active < 0) {
      this.hideFrom(0);
      return;
    }

    sampleIndices(active, this.indices);
    const is3D = snap.mode === "3d";
    let used = 0;
    for (let j = 0; j < this.indices.length; j++) {
      const index = this.indices[j]!;
      const segments = this.slots[used]!;
      const iterate = flatPointXYZ(
        raw.iteratePath,
        index,
        raw.iterateObjectiveVector,
      );
      if (
        !writeEllipseMatrix(this.matrix, ellipsoids, index, iterate?.[2] ?? 0)
      ) {
        continue;
      }
      segments.matrix.copy(this.matrix);
      segments.matrixWorldNeedsUpdate = true;
      // slot styling ramps with recency, not with the slot's own index, so a
      // short run still ends on the bold "current" ellipse
      segments.material = slotMaterial(
        TRAIL_COUNT - this.indices.length + j,
        is3D,
      );
      segments.visible = true;
      used++;
    }
    this.hideFrom(used);

    // The localizing polyhedron is shown only for a hovered (or replayed)
    // iterate. Drawing one per trail slot buries the picture — they nest, they
    // are many-sided, and unlike the ellipses they do not shrink smoothly — so
    // it reads as an inspection tool: point at a row, see the region that
    // iteration was still working in.
    this.showLocalizingSet(raw, snap.mode === "3d");
  }

  private showLocalizingSet(
    raw: ReturnType<SceneContext["getState"]>,
    is3D: boolean,
  ): void {
    const index = raw.highlightIteratePathIndex;
    if (index === null) {
      this.polygon.visible = false;
      return;
    }
    const iterate = flatPointXYZ(
      raw.iteratePath,
      index,
      raw.iterateObjectiveVector,
    );
    const written = this.writePolygon(
      raw.iterateLocalizingSets,
      index,
      iterate?.[2] ?? 0,
    );
    if (written === 0) {
      this.polygon.visible = false;
      return;
    }
    replaceLinePositions(
      this.polygonGeometry,
      this.polygonScratch.subarray(0, written),
    );
    this.polygon.material = polygonMaterial(is3D);
    this.polygon.visible = true;
  }

  // The localizing polygon as segment endpoint pairs, closed back to the start.
  private writePolygon(
    sets: LocalizingSetPath | null,
    index: number,
    z: number,
  ): number {
    if (!sets || index >= sets.count) return 0;
    const start = sets.offsets[index]!;
    const end = sets.offsets[index + 1]!;
    const count = end - start;
    if (count < 2) return 0;

    const needed = count * 6;
    if (this.polygonScratch.length < needed) {
      this.polygonScratch = new Float32Array(needed);
    }
    for (let i = 0; i < count; i++) {
      const from = (start + i) * 2;
      const to = (start + ((i + 1) % count)) * 2;
      const base = i * 6;
      this.polygonScratch[base] = sets.points[from]!;
      this.polygonScratch[base + 1] = sets.points[from + 1]!;
      this.polygonScratch[base + 2] = z;
      this.polygonScratch[base + 3] = sets.points[to]!;
      this.polygonScratch[base + 4] = sets.points[to + 1]!;
      this.polygonScratch[base + 5] = z;
    }
    return needed;
  }

  private hideFrom(slot: number): void {
    for (let i = slot; i < this.slots.length; i++) {
      this.slots[i]!.visible = false;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.polygonGeometry.dispose();
  }
}

// Opacity/width ramp by age. The values come from a fixed slot index so the
// shared line-material cache sees a small, stable set of keys.
function slotOpacity(slot: number) {
  const t = TRAIL_COUNT > 1 ? slot / (TRAIL_COUNT - 1) : 1;
  return OLDEST_OPACITY + (ACTIVE_OPACITY - OLDEST_OPACITY) * t;
}

function slotMaterial(slot: number, is3D: boolean) {
  const newest = slot >= TRAIL_COUNT - 1;
  return lineDepthMaterial(
    ELLIPSOID_COLOR,
    newest ? ACTIVE_THICKNESS : TRAIL_THICKNESS,
    is3D,
    Number(slotOpacity(slot).toFixed(3)),
  );
}

function polygonMaterial(is3D: boolean) {
  return lineDepthMaterial(
    ELLIPSOID_COLOR,
    POLYGON_THICKNESS,
    is3D,
    POLYGON_OPACITY,
  );
}
