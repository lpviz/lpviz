import type { State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import type { Points } from "three";
import { phasesCovering } from "../helpers/phaseColors";
import { type IterateSelection, PointCloud, type PointCloudStyle } from "../helpers/pointCloud";
import type { RenderSlot } from "../Layer";
import { PALETTE, SPRITE } from "../palette";
import { ZScaledLayer } from "./base/LayerBase";

type IterateSpritesSpec = {
  style: PointCloudStyle;
  /** the inputs `select` and `phases` read, beyond the iterate path's view */
  deps: (state: State) => readonly unknown[];
  /** the iterates to mark; indices off the path are skipped */
  select: (state: State) => IterateSelection;
  /** the phases colouring the sprites, when they cover the `count` drawn */
  phases?: (state: State, count: number) => number[] | null;
};

// Sprites on a selection of the iterate path: every iterate, the PDHG restarts, the hovered or
// replayed iterate, the optimum. One layer class; the four differ in look, inputs and selection.
class IterateSpritesLayer extends ZScaledLayer {
  readonly object3D: Points;
  readonly slot: RenderSlot;
  override readonly invalidationKeys = ["iterate"] as const;
  private readonly cloud: PointCloud;

  constructor(private readonly spec: IterateSpritesSpec) {
    super();
    this.cloud = this.own(new PointCloud(spec.style));
    this.object3D = this.cloud.object3D;
    this.slot = spec.style.slot;
  }

  protected dependencies(state: State, snap: ViewportRenderSnapshot): readonly unknown[] {
    return [...this.spec.deps(state), snap.mode];
  }

  protected rebuild(state: State): void {
    const path = state.iteratePath;
    const picked = this.spec.select(state);
    const selection = typeof picked === "number" ? Math.max(0, picked) : picked.filter((index) => index >= 0 && index < path.count);
    const count = typeof selection === "number" ? selection : selection.length;
    this.cloud.drawIterates(path, selection, this.spec.phases?.(state, count) ?? null);
  }
}

/** The solved iterate path as a point cloud, coloured by solver phase when the run has phases. */
export const createIteratePointsLayer = () =>
  new IterateSpritesLayer({
    style: { color: PALETTE.iterate, pixelSize: SPRITE.iterate, shape: "disc", slot: "iteratePoints", vertexColors: true },
    deps: (state) => [state.iteratePath, state.iteratePhases, state.replayActive],
    // A replay's last point is the interpolated head sliding along the current
    // segment, not an iterate. The line layer draws it (that is the sweep), but
    // a dot there would be indistinguishable from a real iterate, so the cloud
    // stops one short and each dot appears exactly as the head reaches it.
    select: (state) => state.iteratePath.count - (state.replayActive ? 1 : 0),
    phases: (state, count) => phasesCovering(state.iteratePhases, count),
  });

/** Square markers on the iterates where PDHG restarted (a subset of the path). */
export const createIterateRestartPointsLayer = () =>
  new IterateSpritesLayer({
    style: { color: PALETTE.iterate, pixelSize: SPRITE.iterate * 1.4, shape: "square", slot: "iterateRestartPoints", vertexColors: true },
    deps: (state) => [state.iteratePath, state.iteratePhases, state.iterateRestartIndices],
    select: (state) => state.iterateRestartIndices,
    phases: (state) => phasesCovering(state.iteratePhases, state.iteratePath.count),
  });

// One sprite at a single iterate of the path: the hover highlight and the star on the optimum
// differ only in shape, size, pass and which index they pick.
const MARKER = { color: PALETTE.iterateMarker, vertexColors: false } as const;

// Marks the current point of the path: the iterate the user is hovering in the
// solver log, or — while a replay sweeps — the head the line is currently
// drawn out to.
export const createIterateHighlightLayer = () =>
  new IterateSpritesLayer({
    style: { ...MARKER, pixelSize: SPRITE.iterate * 2, shape: "disc", slot: "iterateHighlight" },
    deps: (state) => [state.highlightIteratePathIndex, state.replayActive, state.iteratePath],
    // A replay's path ends on an interpolated head that slides along the
    // current segment, so taking its last point keeps this marker in lockstep
    // with the line — same buffer, same frame, same interpolated z — where an
    // integer index would snap from iterate to iterate. The index itself stays
    // on the last whole iterate passed, for consumers that need a real one
    // (EllipsoidLayer picks a per-iteration ellipse with it).
    select: ({ replayActive, iteratePath, highlightIteratePathIndex }) => (replayActive ? [iteratePath.count - 1] : highlightIteratePathIndex === null ? [] : [highlightIteratePathIndex]),
  });

// Marks the final iterate of the solved path (the optimum), shown once any
// replay animation has finished playing out.
export const createIterateStarLayer = () =>
  new IterateSpritesLayer({
    style: { ...MARKER, pixelSize: SPRITE.iterateStar, shape: "star", slot: "iterateStar" },
    deps: (state) => [state.replayActive, state.iteratePath],
    // `replayActive` falls exactly when the replay ends — whether it played out
    // or was stopped — and both leave the full path on screen, so the marker is
    // always on the real optimum when it is shown
    select: (state) => (state.replayActive ? [] : [state.iteratePath.count - 1]),
  });
