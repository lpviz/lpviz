import type { State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { Group } from "three";
import { iteratePosition, iteratePositions, writeIteratePositions } from "../helpers/iteratePositions";
import { PathRibbon } from "../helpers/pathRibbon";
import { PointCloud } from "../helpers/pointCloud";
import { PALETTE, SPRITE, STROKE } from "../palette";
import { stampTraceSequence } from "../trace/sequence";
import { ZScaledLayer } from "./base/LayerBase";

const TRACE_OPACITY = 0.4;
// a path with more iterates than this is sampled, so a chunk's sprites stay this few
const MAX_TRACE_POINT_SPRITES = 1200;

type TraceEntry = State["traceBuffer"][number];

// what one trace entry draws: its ribbon and the sprites on its sampled iterates
type Chunk = { ribbon: PathRibbon; sprites: PointCloud };

// The iterates a chunk's sprites mark: every step-th one, and the last unless the sampling landed
// on its drawn position already (a converged path's last iterates can be the same float32 point).
function sampledIterates(entry: TraceEntry): number[] {
  const step = Math.max(1, Math.ceil(entry.count / MAX_TRACE_POINT_SPRITES));
  const indices: number[] = [];
  for (let i = 0; i < entry.count; i += step) indices.push(i);
  const last = entry.count - 1;
  if (!sameDrawnPosition(entry, indices[indices.length - 1]!, last)) indices.push(last);
  return indices;
}

function sameDrawnPosition(entry: TraceEntry, i: number, j: number): boolean {
  const a = iteratePosition(entry, i)!;
  const b = iteratePosition(entry, j)!;
  return a.every((value, k) => Math.fround(value) === Math.fround(b[k]!));
}

// The trace: the paths of a rotation's earlier solves, each a screen-space ribbon (see
// pathRibbon.ts) with a sprite on every sampled iterate. A trace entry is immutable once appended,
// so it gets a pooled chunk whose path texture and sprite positions are built and uploaded exactly
// once: a rotation step costs one chunk upload, every iterate is drawn (the ribbon is never
// sampled), and previously drawn curves can never shift between frames. Both of a chunk's objects
// carry the entry's append sequence (see trace/sequence.ts), which is what lets the 2D cache bake
// the chunk once and the 3D compositor treat the pass as a whole.
export class TraceLayer extends ZScaledLayer {
  readonly object3D = new Group();
  readonly slot = "traceLine" as const;
  override readonly invalidationKeys = ["trace"] as const;
  // every chunk made, and the ones no entry holds
  private chunks: Chunk[] = [];
  private free: Chunk[] = [];
  private assigned = new Map<TraceEntry, Chunk>();
  // monotonic append sequence stamped on each chunk's objects
  private nextSeq = 0;

  constructor() {
    super();
    // one chunk from the start, so the scene manager compiles the trace's programs ahead of the first trace
    this.free.push(this.makeChunk());
  }

  private makeChunk(): Chunk {
    const chunk: Chunk = {
      ribbon: new PathRibbon({ color: PALETTE.trace, opacity: TRACE_OPACITY, linewidth: STROKE.trace, slot: this.slot }),
      sprites: new PointCloud({ color: PALETTE.trace, pixelSize: SPRITE.tracePoint, shape: "disc", slot: "tracePoints", vertexColors: false }),
    };
    this.object3D.add(chunk.ribbon.object3D, chunk.sprites.object3D);
    this.chunks.push(chunk);
    return chunk;
  }

  protected override visibleIn(state: State, snap: ViewportRenderSnapshot): boolean {
    return state.traceEnabled && state.traceBuffer.length > 0 && super.visibleIn(state, snap);
  }

  protected dependencies(state: State, snap: ViewportRenderSnapshot): readonly unknown[] {
    return [state.traceEnabled, state.traceBuffer, snap.mode];
  }

  protected rebuild(state: State, snap: ViewportRenderSnapshot): void {
    // free the chunks whose entries were evicted from the buffer
    const live = new Set<TraceEntry>(state.traceBuffer);
    for (const [entry, chunk] of this.assigned) {
      if (live.has(entry)) continue;
      this.assigned.delete(entry);
      chunk.ribbon.object3D.visible = false;
      chunk.sprites.object3D.visible = false;
      this.free.push(chunk);
    }

    // build and upload only the entries that have no chunk yet
    for (const entry of state.traceBuffer) {
      if (this.assigned.has(entry) || entry.count < 2) continue;
      const chunk = this.free.pop() ?? this.makeChunk();
      chunk.ribbon.setPath(iteratePositions(entry), entry.count);
      const sampled = sampledIterates(entry);
      chunk.sprites.draw(sampled.length, (out) => writeIteratePositions(out, entry, sampled.length, sampled));
      const seq = this.nextSeq++;
      stampTraceSequence(chunk.ribbon.object3D, seq);
      stampTraceSequence(chunk.sprites.object3D, seq);
      chunk.ribbon.object3D.visible = true;
      this.assigned.set(entry, chunk);
    }

    // the depth mode follows the view, one of the inputs a rebuild answers to
    const is3D = snap.mode === "3d";
    for (const { ribbon } of this.assigned.values()) ribbon.setDepth(is3D);
    if (this.assigned.size === 0) this.hide();
  }

  override dispose(): void {
    for (const { ribbon, sprites } of this.chunks) {
      ribbon.dispose();
      sprites.dispose();
    }
    this.chunks = [];
    this.free = [];
    this.assigned.clear();
  }
}
