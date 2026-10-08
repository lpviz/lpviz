import type { State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { iteratePositions } from "../helpers/iteratePositions";
import { PathRibbon } from "../helpers/pathRibbon";
import { PHASE_COLORS_BYTES } from "../helpers/phaseColors";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { shouldRenderSnapshotMode } from "../helpers/sceneVisibility";
import { PALETTE } from "../palette";
import { ZScaledGroupLayer } from "./base/LayerBase";

const ITERATE_LINE_THICKNESS = 3;

let colorScratch = new Uint8Array(0);

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

// The iterate path renders as a screen-space ribbon (see pathRibbon.ts); phase coloring rides
// along as a per-point color texture, one draw call for the whole path.
export class IterateLineLayer extends ZScaledGroupLayer {
  override readonly renderPass = "trace" as const;
  override readonly invalidationKeys = ["iterate"] as const;
  private ribbon = new PathRibbon({ color: PALETTE.iterate, opacity: 1, linewidth: ITERATE_LINE_THICKNESS });

  constructor() {
    super();
    this.ribbon.mesh.renderOrder = RENDER_ORDER.iterateLine;
    this.object3D.add(this.ribbon.mesh);
  }

  protected dependencies(state: State, snap: ViewportRenderSnapshot): readonly unknown[] {
    return [state.iteratePath, state.iteratePhases, snap.mode];
  }

  protected rebuild(state: State, snap: ViewportRenderSnapshot): void {
    const path = state.iteratePath;
    if (path.count < 2 || !shouldRenderSnapshotMode(snap.mode, state)) {
      this.object3D.visible = false;
      return;
    }

    const hasPhases = state.iteratePhases.length === path.count && state.iteratePhases.length > 0;
    // state z: zScale and the 2D/3D transition flattening are applied via
    // object3D.scale.z, so neither rebuilds the path
    this.ribbon.setPath(iteratePositions(path), path.count, hasPhases ? buildPhaseColors(state.iteratePhases) : null);
    this.ribbon.mesh.visible = true;
    this.object3D.visible = true;
  }

  dispose(): void {
    this.ribbon.dispose();
  }
}
