import { getState, MAX_TRACE_POINT_SPRITES, type State } from "@/features/core/store";
import { getViewportRenderSnapshot } from "@/features/viewport/runtime/snapshot";
import type { PointsMaterial } from "three";
import { BufferAttribute, DynamicDrawUsage } from "three";
import { iteratePositions } from "../helpers/iteratePositions";
import { makePoints, pointsMaterial } from "../helpers/points";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { shouldRenderSnapshotMode } from "../helpers/sceneVisibility";
import { SHARED_CIRCLE_TEXTURE } from "../helpers/sharedTextures";
import { ZScaledGroupLayer } from "./base/LayerBase";

const TRACE_COLOR = "#ffa500";
const TRACE_POINT_PIXEL_SIZE = 6;
const TRACE_POINTS_RENDER_ORDER = RENDER_ORDER.tracePoints;

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

const tracePointPositionCache = new WeakMap<object, Float32Array>();

function getCachedTracePointPositions(entry: TraceEntry) {
  const cached = tracePointPositionCache.get(entry);
  if (cached) return cached;
  const sampled = entry.count === 0 ? new Float32Array() : new Float32Array(buildTraceSamplePositions(iteratePositions(entry), entry.count));
  tracePointPositionCache.set(entry, sampled);
  return sampled;
}

// grow-only concat scratch: the buffer changes on every rotation step, and
// allocating the full concatenation each time churns the GC
let concatScratch = new Float32Array(0);

function buildAllTracePointPositions(raw: State, mode: "2d" | "3d"): { array: Float32Array; length: number } {
  if (!raw.traceEnabled || raw.traceBuffer.length === 0 || !shouldRenderSnapshotMode(mode, raw)) {
    return { array: concatScratch, length: 0 };
  }
  let total = 0;
  for (const entry of raw.traceBuffer) {
    total += getCachedTracePointPositions(entry).length;
  }
  if (concatScratch.length < total) {
    concatScratch = new Float32Array(Math.max(total, concatScratch.length * 2));
  }
  let offset = 0;
  for (const entry of raw.traceBuffer) {
    const chunk = getCachedTracePointPositions(entry);
    concatScratch.set(chunk, offset);
    offset += chunk.length;
  }
  return { array: concatScratch, length: total };
}

export class TracePointsLayer extends ZScaledGroupLayer {
  override readonly renderPass = "trace" as const;
  override readonly invalidationKeys = ["trace"] as const;
  private pts = makePoints(pointsMaterial(SHARED_CIRCLE_TEXTURE, TRACE_POINT_PIXEL_SIZE, TRACE_COLOR), TRACE_POINTS_RENDER_ORDER, true);

  constructor() {
    super();
    this.object3D.add(this.pts);
  }

  protected dependencies(): readonly unknown[] {
    const raw = getState();
    return [raw.traceEnabled, raw.traceBuffer, raw.is3DMode, raw.isTransitioning3D, getViewportRenderSnapshot().mode];
  }

  protected rebuild(): void {
    const raw = getState();
    const positions = buildAllTracePointPositions(raw, getViewportRenderSnapshot().mode);
    this.object3D.visible = positions.length > 0;
    if (positions.length > 0) {
      // grow-only attribute updated in place (see concatScratch)
      const count = positions.length / 3;
      const geometry = this.pts.geometry;
      let attr = geometry.getAttribute("position") as BufferAttribute | undefined;
      if (!attr || attr.array !== positions.array || attr.count < count) {
        attr = new BufferAttribute(positions.array, 3);
        attr.setUsage(DynamicDrawUsage);
        geometry.dispose();
        geometry.setAttribute("position", attr);
      } else {
        attr.needsUpdate = true;
      }
      geometry.setDrawRange(0, count);
    }
  }

  dispose(): void {
    (this.pts.material as PointsMaterial).dispose();
    this.pts.geometry.dispose();
  }
}
