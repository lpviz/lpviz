import { type IteratePath } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import type { PointXY } from "@lpviz/math/types";
import { Group } from "three";
import { writeFlatXYZ } from "../helpers/flatPositions";
import { PathRibbon } from "../helpers/pathRibbon";
import { PathTube } from "../helpers/pathTube";
import { PHASE_COLORS_BYTES } from "../helpers/phaseColors";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { shouldRenderSnapshotMode } from "../helpers/sceneVisibility";
import type { SceneContext } from "../SceneContext";
import { LayerBase } from "./base/LayerBase";

const ITERATE_LINE_COLOR = "#800080";
const ITERATE_LINE_THICKNESS = 3;

let pointScratch = new Float32Array(0);
let colorScratch = new Uint8Array(0);

function buildPositions(
  path: IteratePath,
  objectiveVector: PointXY | null,
): Float32Array {
  // raw z: zScale and the 2D/3D transition flattening are applied via
  // object3D.scale.z, so neither rebuilds the path
  if (pointScratch.length < path.count * 3) {
    pointScratch = new Float32Array(path.count * 3);
  }
  writeFlatXYZ(pointScratch, path.points, path.count, path.stride, objectiveVector);
  return pointScratch;
}

function buildPhaseColors(phases: number[]): Uint8Array {
  if (colorScratch.length < phases.length * 4) {
    colorScratch = new Uint8Array(phases.length * 4);
  }
  for (let i = 0; i < phases.length; i++) {
    const rgb = PHASE_COLORS_BYTES[phases[i]! % PHASE_COLORS_BYTES.length]!;
    const base = i * 4;
    colorScratch[base] = rgb[0];
    colorScratch[base + 1] = rgb[1];
    colorScratch[base + 2] = rgb[2];
    colorScratch[base + 3] = 255;
  }
  return colorScratch;
}

// World units per CSS pixel per unit of view depth for the perspective
// camera; the tube shader multiplies it by each vertex's own depth so the
// tube is a constant number of pixels wide wherever the path goes.
function perspectivePixelScale(snap: ViewportRenderSnapshot): number {
  return (2 * Math.tan((snap.perspective.fov * Math.PI) / 360)) / Math.max(1, snap.height);
}

// In 2D the iterate path renders as a screen-space ribbon (see pathRibbon.ts):
// true fat-line styling without Line2's quad-per-segment cost, which made
// every camera frame pay for up to maxit capped quads. In 3D — the /3d editor
// and the 2D problem's lifted view alike — the same points render as a
// world-space tube (see pathTube.ts) so the path has a consistent width from
// every angle and shades like a solid. Both share the path/color textures'
// upload path; only the active one is fed. Phase coloring rides along as a
// per-point color texture, replacing the old one-Line2-per-phase-segment pool
// (and its draw call per segment).
export class IterateLineLayer extends LayerBase {
  readonly object3D: Group;
  override readonly renderPass = "trace" as const;
  override readonly invalidationKeys = ["iterate"] as const;
  private ribbon: PathRibbon | null = null;
  private tube: PathTube | null = null;

  constructor() {
    super();
    this.object3D = new Group();
  }

  protected override everyFrame(ctx: SceneContext): void {
    this.syncViewUniforms(ctx);
  }

  // zScale and the 2D/3D flatten: the ribbon takes them as a z scale on its
  // mesh (its width is screen-space, so squashing z is harmless); the tube
  // takes them as a uniform so its circular cross-section stays circular, plus
  // the camera's pixel scale for its constant on-screen width. Frames render
  // on demand, so this also runs right after a renderer is created — the base
  // class calls everyFrame before rebuild, and a first frame drawn with
  // uniform defaults would otherwise stick until the next invalidation.
  private syncViewUniforms(ctx: SceneContext): void {
    const snap = ctx.getSnapshot();
    const zFactor = (ctx.getState().zScale / 100) * snap.transitionZMultiplier;
    if (this.ribbon) this.ribbon.mesh.scale.z = zFactor;
    if (this.tube) {
      this.tube.setZFactor(zFactor);
      this.tube.setPixelScale(perspectivePixelScale(snap));
    }
  }

  protected dependencies(ctx: SceneContext): readonly unknown[] {
    const raw = ctx.getState();
    return [
      raw.iteratePath,
      raw.iteratePhases,
      raw.iterateObjectiveVector,
      ctx.getSnapshot().mode,
    ];
  }

  protected rebuild(ctx: SceneContext): void {
    const raw = ctx.getState();
    if (
      raw.iteratePath.count < 2 ||
      !shouldRenderSnapshotMode(ctx.getSnapshot().mode, raw)
    ) {
      this.object3D.visible = false;
      return;
    }

    const hasPhases =
      raw.iteratePhases.length === raw.iteratePath.count &&
      raw.iteratePhases.length > 0;
    const points = buildPositions(raw.iteratePath, raw.iterateObjectiveVector);
    const colors = hasPhases ? buildPhaseColors(raw.iteratePhases) : null;

    if (ctx.getSnapshot().mode === "3d") {
      if (!this.tube) {
        this.tube = new PathTube({
          color: ITERATE_LINE_COLOR,
          opacity: 1,
          pixelRadius: 0.5 * ITERATE_LINE_THICKNESS,
        });
        this.tube.mesh.renderOrder = RENDER_ORDER.iterateLine;
        this.object3D.add(this.tube.mesh);
        this.syncViewUniforms(ctx);
      }
      this.tube.setPath(points, raw.iteratePath.count, colors);
      this.tube.mesh.visible = true;
      if (this.ribbon) this.ribbon.mesh.visible = false;
    } else {
      if (!this.ribbon) {
        this.ribbon = new PathRibbon({
          color: ITERATE_LINE_COLOR,
          opacity: 1,
          linewidth: ITERATE_LINE_THICKNESS,
        });
        this.ribbon.mesh.renderOrder = RENDER_ORDER.iterateLine;
        this.object3D.add(this.ribbon.mesh);
        this.syncViewUniforms(ctx);
      }
      this.ribbon.setPath(points, raw.iteratePath.count, colors);
      this.ribbon.mesh.visible = true;
      if (this.tube) this.tube.mesh.visible = false;
    }
    this.object3D.visible = true;
  }

  dispose(): void {
    this.ribbon?.dispose();
    this.ribbon = null;
    this.tube?.dispose();
    this.tube = null;
  }
}
