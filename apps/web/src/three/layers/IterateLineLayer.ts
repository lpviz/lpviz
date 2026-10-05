import { type IteratePath } from "@/features/core/store";
import type { PointXY } from "@lpviz/math/types";
import { Group } from "three";
import { writeFlatXYZ } from "../helpers/flatPositions";
import { PathRibbon } from "../helpers/pathRibbon";
import { PHASE_COLORS_BYTES } from "../helpers/phaseColors";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { shouldRenderSnapshotMode } from "../helpers/sceneVisibility";
import type { SceneContext } from "../SceneContext";
import { LayerBase } from "./base/LayerBase";

const ITERATE_LINE_COLOR = "#800080";
const ITERATE_LINE_THICKNESS = 3;

let pointScratch = new Float32Array(0);
let colorScratch = new Uint8Array(0);

function buildPositions(path: IteratePath, objectiveVector: PointXY | null): Float32Array {
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

// The iterate path renders as a screen-space ribbon (see pathRibbon.ts):
// true fat-line styling without Line2's quad-per-segment cost, which made
// every camera frame pay for up to maxit capped quads. Phase coloring rides
// along as a per-point color texture, replacing the old one-Line2-per-phase-
// segment pool (and its draw call per segment).
export class IterateLineLayer extends LayerBase {
  readonly object3D: Group;
  override readonly renderPass = "trace" as const;
  override readonly invalidationKeys = ["iterate"] as const;
  private ribbon: PathRibbon | null = null;

  constructor() {
    super();
    this.object3D = new Group();
  }

  protected override everyFrame(ctx: SceneContext): void {
    this.applyZScale(ctx);
  }

  protected dependencies(ctx: SceneContext): readonly unknown[] {
    const raw = ctx.getState();
    return [raw.iteratePath, raw.iteratePhases, raw.iterateObjectiveVector, ctx.getSnapshot().mode];
  }

  protected rebuild(ctx: SceneContext): void {
    const raw = ctx.getState();
    if (raw.iteratePath.count < 2 || !shouldRenderSnapshotMode(ctx.getSnapshot().mode, raw)) {
      this.object3D.visible = false;
      return;
    }

    if (!this.ribbon) {
      this.ribbon = new PathRibbon({
        color: ITERATE_LINE_COLOR,
        opacity: 1,
        linewidth: ITERATE_LINE_THICKNESS,
      });
      this.ribbon.mesh.renderOrder = RENDER_ORDER.iterateLine;
      this.object3D.add(this.ribbon.mesh);
    }

    const hasPhases = raw.iteratePhases.length === raw.iteratePath.count && raw.iteratePhases.length > 0;
    this.ribbon.setPath(buildPositions(raw.iteratePath, raw.iterateObjectiveVector), raw.iteratePath.count, hasPhases ? buildPhaseColors(raw.iteratePhases) : null);
    this.ribbon.mesh.visible = true;
    this.object3D.visible = true;
  }

  dispose(): void {
    this.ribbon?.dispose();
    this.ribbon = null;
  }
}
