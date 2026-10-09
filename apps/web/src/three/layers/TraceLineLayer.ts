import { type State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { Group } from "three";
import { iteratePositions } from "../helpers/iteratePositions";
import { PathRibbon } from "../helpers/pathRibbon";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { shouldRenderSnapshotMode } from "../helpers/sceneVisibility";
import { stampTraceSequence } from "../helpers/traceSequence";
import { PALETTE } from "../palette";
import { ZScaledLayer } from "./base/LayerBase";

const TRACE_OPACITY = 0.4;
const TRACE_LINE_THICKNESS = 2;

type TraceEntry = State["traceBuffer"][number];

// Trace paths render as screen-space ribbons (see pathRibbon.ts): the same
// 2px fat-line styling as the rest of the app without Line2's quad-per-
// segment cost, which is unaffordable at millions of sub-pixel segments.
// Each trace entry is immutable once appended, so it gets its own pooled
// ribbon whose path texture is built and uploaded exactly once — a rotation
// step costs one chunk upload, every iterate is drawn (no sampling), and
// previously drawn curves can never shift between frames.
export class TraceLineLayer extends ZScaledLayer {
  readonly object3D = new Group();
  override readonly renderPass = "traceLines" as const;
  override readonly invalidationKeys = ["trace"] as const;
  private pool: PathRibbon[] = [];
  private assigned = new Map<TraceEntry, PathRibbon>();
  private lastMode: string | null = null;
  // monotonic append sequence stamped on each ribbon mesh (see traceSequence.ts)
  private nextSeq = 0;

  private makeRibbon(): PathRibbon {
    const ribbon = new PathRibbon({
      color: PALETTE.trace,
      opacity: TRACE_OPACITY,
      linewidth: TRACE_LINE_THICKNESS,
    });
    ribbon.mesh.renderOrder = RENDER_ORDER.traceLine;
    this.object3D.add(ribbon.mesh);
    this.pool.push(ribbon);
    return ribbon;
  }

  protected override visibleIn(state: State, snap: ViewportRenderSnapshot): boolean {
    return state.traceEnabled && state.traceBuffer.length > 0 && shouldRenderSnapshotMode(snap.mode, state);
  }

  protected dependencies(state: State, snap: ViewportRenderSnapshot): readonly unknown[] {
    return [state.traceEnabled, state.traceBuffer, snap.mode];
  }

  protected rebuild(state: State, snap: ViewportRenderSnapshot): void {
    const modeChanged = this.lastMode !== snap.mode;
    this.lastMode = snap.mode;

    // Recycle ribbons whose entries were evicted from the buffer
    const live = new Set<TraceEntry>(state.traceBuffer);
    const freed: PathRibbon[] = [];
    for (const [entry, ribbon] of this.assigned) {
      if (!live.has(entry)) {
        this.assigned.delete(entry);
        ribbon.mesh.visible = false;
        freed.push(ribbon);
      }
    }

    // Build the path texture only for entries that don't have one yet
    const is3D = snap.mode === "3d";
    for (const entry of state.traceBuffer) {
      if (this.assigned.has(entry)) continue;
      if (entry.count < 2) continue;
      const ribbon = freed.pop() ?? this.makeRibbon();
      ribbon.setPath(iteratePositions(entry), entry.count);
      ribbon.setDepth(is3D);
      stampTraceSequence(ribbon.mesh, this.nextSeq++);
      ribbon.mesh.visible = true;
      this.assigned.set(entry, ribbon);
    }
    for (const ribbon of freed) ribbon.mesh.visible = false;

    if (modeChanged) {
      for (const ribbon of this.assigned.values()) ribbon.setDepth(is3D);
    }

    this.object3D.visible = this.assigned.size > 0;
  }

  dispose(): void {
    for (const ribbon of this.pool) ribbon.dispose();
    this.pool = [];
    this.assigned.clear();
  }
}
