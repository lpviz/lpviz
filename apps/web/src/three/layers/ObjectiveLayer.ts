import type { State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { isUnboundedDirection } from "@/features/problem/selectors";
import { FatLine } from "../helpers/fatLine";
import { PALETTE, STROKE } from "../palette";
import { LayerBase } from "./base/LayerBase";

const OBJECTIVE_HEAD_LENGTH_PX = 16;
const ARROW_HALF_ANGLE = Math.PI / 6;
const OBJECTIVE_EPSILON = 1e-3;

export class ObjectiveLayer extends LayerBase {
  readonly slot = "objective" as const;
  private readonly line = new FatLine({ color: PALETTE.objective, linewidth: STROKE.objective, slot: this.slot });
  readonly object3D = this.line.object3D;
  override readonly invalidationKeys = ["objective"] as const;

  protected dependencies(state: State, snap: ViewportRenderSnapshot): readonly unknown[] {
    return [state.objectiveVector, state.currentObjective, state.completionMode, state.polytope, snap.mode, snap.unitsPerPixel];
  }

  protected override visibleIn(state: State, snap: ViewportRenderSnapshot): boolean {
    return !state.objectiveHidden && super.visibleIn(state, snap);
  }

  protected rebuild(state: State, snap: ViewportRenderSnapshot): void {
    const target = state.objectiveVector || (state.completionMode !== "draft" && state.currentObjective ? state.currentObjective : null);
    if (!target || Math.hypot(target[0], target[1]) < OBJECTIVE_EPSILON) {
      this.hide();
      return;
    }

    const headLength = OBJECTIVE_HEAD_LENGTH_PX * snap.unitsPerPixel;
    const angle = Math.atan2(target[1], target[0]);

    // the shaft, then the two arrow-head strokes back from the tip
    const positions = [0, 0, 0, target[0], target[1], 0];
    for (const offset of [ARROW_HALF_ANGLE, -ARROW_HALF_ANGLE]) {
      const a = angle + offset;
      positions.push(target[0], target[1], 0, target[0] - headLength * Math.cos(a), target[1] - headLength * Math.sin(a), 0);
    }

    // the accent colour says the objective points where the region is unbounded
    this.line.draw(positions, snap.mode === "3d", isUnboundedDirection(state, target) ? PALETTE.accent : PALETTE.objective);
  }

  dispose(): void {
    this.line.dispose();
  }
}
