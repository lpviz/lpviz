import type { State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { iteratePositions } from "../helpers/iteratePositions";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { SHARED_CIRCLE_TEXTURE } from "../helpers/sharedTextures";
import { PALETTE } from "../palette";
import { PointCloudLayer } from "./base/PointCloudLayer";

const TRACE_POINT_PIXEL_SIZE = 6;
// a path with more iterates than this is sampled, so the cloud stays this big per trace
const MAX_TRACE_POINT_SPRITES = 1200;

type TraceEntry = State["traceBuffer"][number];

// Every step-th point of a path plus its last point, as flat [x, y, z].
function buildTraceSamplePositions(pathPositions: Float32Array, pointCount: number) {
  const step = Math.max(1, Math.ceil(pointCount / MAX_TRACE_POINT_SPRITES));
  const samples: number[] = [];
  for (let i = 0; i < pointCount; i += step) {
    samples.push(pathPositions[i * 3]!, pathPositions[i * 3 + 1]!, pathPositions[i * 3 + 2]!);
  }
  const lastBase = (pointCount - 1) * 3;
  if (
    samples.length === 0 ||
    samples[samples.length - 3] !== pathPositions[lastBase] ||
    samples[samples.length - 2] !== pathPositions[lastBase + 1] ||
    samples[samples.length - 1] !== pathPositions[lastBase + 2]
  ) {
    samples.push(pathPositions[lastBase]!, pathPositions[lastBase + 1]!, pathPositions[lastBase + 2]!);
  }
  return samples;
}

// a trace entry is immutable once appended, so its samples are computed once
const tracePointPositionCache = new WeakMap<object, Float32Array>();

function getCachedTracePointPositions(entry: TraceEntry) {
  const cached = tracePointPositionCache.get(entry);
  if (cached) return cached;
  const sampled = entry.count === 0 ? new Float32Array() : new Float32Array(buildTraceSamplePositions(iteratePositions(entry), entry.count));
  tracePointPositionCache.set(entry, sampled);
  return sampled;
}

// Sampled points of every traced path, in one cloud.
export class TracePointsLayer extends PointCloudLayer {
  constructor() {
    super({
      color: PALETTE.trace,
      pixelSize: TRACE_POINT_PIXEL_SIZE,
      texture: SHARED_CIRCLE_TEXTURE,
      renderOrder: RENDER_ORDER.tracePoints,
      renderPass: "trace",
      invalidationKeys: ["trace"],
      vertexColors: false,
    });
  }

  protected override visibleIn(state: State, snap: ViewportRenderSnapshot): boolean {
    return state.traceEnabled && state.traceBuffer.length > 0 && super.visibleIn(state, snap);
  }

  protected dependencies(state: State, snap: ViewportRenderSnapshot): readonly unknown[] {
    return [state.traceEnabled, state.traceBuffer, snap.mode];
  }

  protected rebuild(state: State): void {
    const chunks = state.traceBuffer.map(getCachedTracePointPositions);
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    this.draw(total / 3, (positions) => {
      let offset = 0;
      for (const chunk of chunks) {
        positions.set(chunk, offset);
        offset += chunk.length;
      }
    });
  }
}
