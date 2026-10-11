import type { State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { iteratePosition } from "../helpers/iteratePositions";
import type { SpriteShape } from "../helpers/pointCloud";
import { RENDER_ORDER } from "../helpers/renderOrder";
import type { RenderPassName } from "../Layer";
import { PALETTE } from "../palette";
import { ITERATE_POINT_PIXEL_SIZE } from "./IteratePointsLayer";
import { PointCloudLayer } from "./base/PointCloudLayer";

type IterateMarkerConfig = {
  pixelSize: number;
  shape: SpriteShape;
  renderOrder: number;
  renderPass: RenderPassName;
  /** the iterate index to mark, or null to hide */
  selectIndex: (state: State) => number | null;
  /** the inputs `selectIndex` reads, beyond the iterate path */
  selectorDeps: (state: State) => readonly unknown[];
};

// One sprite at a single iterate of the path: the star on the optimum and the hover highlight
// differ only in shape, size, pass and which index they pick.
class IterateMarkerLayer extends PointCloudLayer {
  private readonly selectIndex: IterateMarkerConfig["selectIndex"];
  private readonly selectorDeps: IterateMarkerConfig["selectorDeps"];

  constructor({ selectIndex, selectorDeps, ...style }: IterateMarkerConfig) {
    super({ ...style, color: PALETTE.iterateMarker, invalidationKeys: ["iterate"], vertexColors: false });
    this.selectIndex = selectIndex;
    this.selectorDeps = selectorDeps;
  }

  protected dependencies(state: State, snap: ViewportRenderSnapshot): readonly unknown[] {
    return [...this.selectorDeps(state), state.iteratePath, snap.mode];
  }

  protected rebuild(state: State): void {
    const index = this.selectIndex(state);
    const xyz = index === null ? null : iteratePosition(state.iteratePath, index);
    if (!xyz) {
      this.hide();
      return;
    }
    this.draw(1, (pos) => pos.set(xyz));
  }
}

// Marks the current point of the path: the iterate the user is hovering in the
// solver log, or — while a replay sweeps — the head the line is currently
// drawn out to.
export const createIterateHighlightLayer = () =>
  new IterateMarkerLayer({
    pixelSize: ITERATE_POINT_PIXEL_SIZE * 2,
    shape: "disc",
    renderOrder: RENDER_ORDER.iterateHighlight,
    renderPass: "trace",
    selectorDeps: (state) => [state.highlightIteratePathIndex, state.replayActive],
    // A replay's path ends on an interpolated head that slides along the
    // current segment, so taking its last point keeps this marker in lockstep
    // with the line — same buffer, same frame, same interpolated z — where an
    // integer index would snap from iterate to iterate. The index itself stays
    // on the last whole iterate passed, for consumers that need a real one
    // (EllipsoidLayer picks a per-iteration ellipse with it).
    selectIndex: (state) => (state.replayActive ? (state.iteratePath.count > 0 ? state.iteratePath.count - 1 : null) : state.highlightIteratePathIndex),
  });

// Marks the final iterate of the solved path (the optimum), shown once any
// replay animation has finished playing out.
export const createIterateStarLayer = () =>
  new IterateMarkerLayer({
    pixelSize: 27,
    shape: "star",
    renderOrder: RENDER_ORDER.iterateStar,
    renderPass: "overlay",
    selectorDeps: (state) => [state.replayActive],
    // `replayActive` falls exactly when the replay ends — whether it played out
    // or was stopped — and both leave the full path on screen, so the marker is
    // always on the real optimum when it is shown
    selectIndex: (state) => (state.iteratePath.count === 0 || state.replayActive ? null : state.iteratePath.count - 1),
  });
