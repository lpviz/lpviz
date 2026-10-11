import type { Object3D, WebGLRenderer } from "three";
import { OrthographicCamera, Scene } from "three";
import { bakeTrace } from "./helpers/pathRibbon";
import { CompositeQuad, OffscreenTarget, SettleTimer, type TraceFrame, type TraceImpostor, type TracePassImpostor, VIEW_SETTLE_MS, ViewMotion } from "./helpers/traceComposite";
import { traceSequenceOf } from "./helpers/traceSequence";

// World-anchored impostor for the trace render pass in 2D mode. Trace chunks are immutable
// once appended, so the offscreen target is an accumulation buffer keyed by each chunk's append
// sequence number (see traceSequence.ts): appends draw only the new chunks into
// the existing target with no clear (alpha-over of one shared color and opacity is associative,
// so neither chunk order nor the order of the two composite quads changes the blend). Evictions
// cannot be un-blended, so a rebuild leaves the oldest TRAILING_HEADROOM chunks out of the main
// bake and renders them through a trailing target that re-renders only when an eviction shrinks
// it; once evictions stop they are folded into the main target. Both targets render through the
// same camera, viewport and shader path, so a chunk is pixel-identical wherever it lives.
//
// The cache covers the visible rect plus a pan margin at the canvas's device pixels-per-world-unit
// and fully rebuilds on a zoom change, a pan beyond the margin, a resize, or a round trip through
// 3D. Zoom rebuilds are deferred while the zoom is changing: the quads are world-anchored, so only
// the screen-space stroke width drifts, until the drift passes ZOOM_REBUILD_RATIO, the view
// escapes the cached rect, or the view is quiet for VIEW_SETTLE_MS.
const CACHE_MARGIN = 1.25;
// match the antialiasing of the default framebuffer so cached strokes look
// identical to directly rendered ones
const CACHE_SAMPLES = 4;
const MAX_CACHE_DIMENSION = 8192;
const TRAILING_HEADROOM = 16;
// evictions arrive every few frames during rotation; a quiet half second
// means it stopped and the trailing chunks can be folded into the cache
const EVICTION_QUIET_MS = 500;
// mid-gesture stroke-width drift allowed before a rebuild re-crisps anyway
const ZOOM_REBUILD_RATIO = 1.25;
// fast pans can escape the margin every couple of frames; mid-gesture the rebuilds are rate
// limited (the world-anchored quads keep compositing, so only the freshly exposed strip lacks
// trace history) and each rebuilt rect leads the pan direction to make escapes rarer
const PAN_REBUILD_INTERVAL_MS = 120;
const PAN_LEAD_FRAMES = 12;

const QUAD_VERTEX_SHADER = /* glsl */ `
out vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

type ViewParams = {
  width: number;
  height: number;
  unitsPerPixel: number;
  dpr: number;
  pixelWidth: number;
  pixelHeight: number;
  centerX: number;
  centerY: number;
};

export class TraceCache implements TraceImpostor {
  private cacheCamera = new OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  private quadScene = new Scene();
  private quad = new CompositeQuad(QUAD_VERTEX_SHADER, 1);
  private trailingQuad = new CompositeQuad(QUAD_VERTEX_SHADER, 1);
  private readonly main = new OffscreenTarget(this.quad, { depthBuffer: false });
  private readonly trailing = new OffscreenTarget(this.trailingQuad, { depthBuffer: false });
  private fullRebuildNeeded = true;
  // live chunks with seq in [bakeStart, bakedEnd) are baked into the main
  // target; live chunks below bakeStart render through the trailing target
  private bakeStart = 0;
  private bakedEnd = 0;
  private trailingStart = 0;
  private trailingEnd = 0;
  private lastMinSeq = -1;
  private lastEvictionAt = -Infinity;
  // the view as [unitsPerPixel, centerX, centerY]
  private readonly motion = new ViewMotion(3);
  private lastRebuildAt = -Infinity;
  private panVelocityX = 0;
  private panVelocityY = 0;
  private degraded = false;
  private settle: SettleTimer;
  private liveChunks: Object3D[] = [];
  private visibilityScratch: boolean[] = [];
  private cachedUnitsPerPixel = 0;
  private cachedCenterX = 0;
  private cachedCenterY = 0;
  private cachedHalfWidth = 0;
  private cachedHalfHeight = 0;
  private cachedPixelWidth = 0;
  private cachedPixelHeight = 0;
  private cachedCssWidth = 0;
  private cachedCssHeight = 0;

  constructor(requestFrame: () => void) {
    this.settle = new SettleTimer(requestFrame, Math.max(VIEW_SETTLE_MS, EVICTION_QUIET_MS / 2));
    this.trailingQuad.mesh.renderOrder = 1;
    this.quadScene.add(this.quad.mesh, this.trailingQuad.mesh);
  }

  markContentDirty(): void {
    this.fullRebuildNeeded = true;
  }

  // The live chunks' objects (into liveChunks) and the range of their sequence numbers, or null
  // when the pass draws nothing.
  private collectLiveChunks(traceScene: Scene): { minSeq: number; maxSeq: number } | null {
    const live = this.liveChunks;
    live.length = 0;
    let minSeq = Infinity;
    let maxSeq = -Infinity;
    traceScene.traverseVisible((object) => {
      const seq = traceSequenceOf(object);
      if (seq === undefined) return;
      live.push(object);
      if (seq < minSeq) minSeq = seq;
      if (seq > maxSeq) maxSeq = seq;
    });
    return live.length === 0 ? null : { minSeq, maxSeq };
  }

  // Evictions and view motion, as the rebuild policy reads them: whether chunks were evicted
  // recently, and whether the view moved recently (with the pan velocity that leads a rebuild).
  private trackMotion(now: number, minSeq: number, unitsPerPixel: number, centerX: number, centerY: number): { evicting: boolean; viewMoving: boolean } {
    if (minSeq > this.lastMinSeq && this.lastMinSeq >= 0) {
      this.lastEvictionAt = now;
    }
    this.lastMinSeq = minSeq;
    const evicting = now - this.lastEvictionAt < EVICTION_QUIET_MS;

    const previousCenterX = this.motion.previous(1);
    const previousCenterY = this.motion.previous(2);
    if (this.motion.update(now, [unitsPerPixel, centerX, centerY])) {
      // smoothed per-frame pan velocity, used to lead rebuilt rects
      this.panVelocityX = 0.6 * this.panVelocityX + 0.4 * (Number.isNaN(previousCenterX) ? 0 : centerX - previousCenterX);
      this.panVelocityY = 0.6 * this.panVelocityY + 0.4 * (Number.isNaN(previousCenterY) ? 0 : centerY - previousCenterY);
    }
    const viewMoving = this.motion.moving(now);
    if (!viewMoving) {
      this.panVelocityX = 0;
      this.panVelocityY = 0;
    }
    return { evicting, viewMoving };
  }

  // Prepares the impostor for the trace pass. Returns the scene with
  // the composite quads (the caller renders it in place of the pass), or
  // null when the pass must render directly.
  prepare(frame: TraceFrame): TracePassImpostor | null {
    const { renderer, snapshot, state, trace: traceScene } = frame;
    if (snapshot.mode !== "2d" || state.isTransitioning3D) {
      // keep a stale billboard from surviving a round trip through 3D
      this.fullRebuildNeeded = true;
      return null;
    }

    const chunks = this.collectLiveChunks(traceScene);
    if (!chunks) {
      this.fullRebuildNeeded = true;
      this.quad.mesh.visible = false;
      this.trailingQuad.mesh.visible = false;
      this.trailing.release();
      return null;
    }
    const { minSeq, maxSeq } = chunks;
    const live = this.liveChunks;

    const width = snapshot.width || 1;
    const height = snapshot.height || 1;
    const unitsPerPixel = snapshot.unitsPerPixel;
    const dpr = renderer.getPixelRatio();
    const pixelWidth = Math.min(MAX_CACHE_DIMENSION, Math.ceil(width * CACHE_MARGIN * dpr));
    const pixelHeight = Math.min(MAX_CACHE_DIMENSION, Math.ceil(height * CACHE_MARGIN * dpr));
    const halfVisibleWidth = (width * unitsPerPixel) / 2;
    const halfVisibleHeight = (height * unitsPerPixel) / 2;
    const centerX = snapshot.target.x;
    const centerY = snapshot.target.y;

    const panContained =
      centerX + halfVisibleWidth <= this.cachedCenterX + this.cachedHalfWidth &&
      centerX - halfVisibleWidth >= this.cachedCenterX - this.cachedHalfWidth &&
      centerY + halfVisibleHeight <= this.cachedCenterY + this.cachedHalfHeight &&
      centerY - halfVisibleHeight >= this.cachedCenterY - this.cachedHalfHeight;

    const now = performance.now();
    const { evicting, viewMoving } = this.trackMotion(now, minSeq, unitsPerPixel, centerX, centerY);
    const zoomRatio = this.cachedUnitsPerPixel > 0 ? this.cachedUnitsPerPixel / unitsPerPixel : 1;
    const zoomDeferred = unitsPerPixel !== this.cachedUnitsPerPixel && viewMoving && zoomRatio < ZOOM_REBUILD_RATIO && zoomRatio > 1 / ZOOM_REBUILD_RATIO;
    const panDeferred =
      !panContained &&
      viewMoving &&
      now - this.lastRebuildAt < PAN_REBUILD_INTERVAL_MS &&
      this.main.current !== null &&
      !this.fullRebuildNeeded &&
      pixelWidth === this.cachedPixelWidth &&
      pixelHeight === this.cachedPixelHeight &&
      (unitsPerPixel === this.cachedUnitsPerPixel || zoomDeferred) &&
      minSeq <= this.bakeStart;

    let trailingDirty = false;
    if (
      this.fullRebuildNeeded ||
      !this.main.current ||
      (unitsPerPixel !== this.cachedUnitsPerPixel && !zoomDeferred) ||
      pixelWidth !== this.cachedPixelWidth ||
      pixelHeight !== this.cachedPixelHeight ||
      (!panContained && !panDeferred) ||
      minSeq > this.bakeStart ||
      (this.degraded && !viewMoving && !evicting)
    ) {
      // under active eviction, leave the oldest chunks out of the bake so
      // the next evictions don't each force another full rebuild
      const headroom = evicting ? Math.min(TRAILING_HEADROOM, live.length >> 2) : 0;
      this.bakeStart = minSeq + headroom;
      this.bakedEnd = maxSeq + 1;
      // lead the pan direction so a sustained drag escapes the margin less
      // often; capped so the visible rect stays inside the rebuilt rect
      const slackX = ((pixelWidth / dpr) * unitsPerPixel) / 2 - halfVisibleWidth;
      const slackY = ((pixelHeight / dpr) * unitsPerPixel) / 2 - halfVisibleHeight;
      const clampLead = (lead: number, slack: number) => Math.max(-slack * 0.8, Math.min(slack * 0.8, lead));
      const leadX = viewMoving ? clampLead(this.panVelocityX * PAN_LEAD_FRAMES, slackX) : 0;
      const leadY = viewMoving ? clampLead(this.panVelocityY * PAN_LEAD_FRAMES, slackY) : 0;
      this.lastRebuildAt = now;
      this.recache(
        renderer,
        traceScene,
        {
          width,
          height,
          unitsPerPixel,
          dpr,
          pixelWidth,
          pixelHeight,
          centerX: centerX + leadX,
          centerY: centerY + leadY,
        },
        viewMoving || evicting,
      );
      trailingDirty = true;
    } else {
      if (maxSeq >= this.bakedEnd) {
        // new chunks: accumulate into the existing target without clearing
        this.renderSeqRange(renderer, traceScene, this.main, this.bakedEnd, maxSeq + 1, false);
        this.bakedEnd = maxSeq + 1;
      }
      if (this.bakeStart > minSeq && !evicting) {
        // evictions stopped: fold the trailing chunks into the main bake so
        // the trailing target can be released
        this.renderSeqRange(renderer, traceScene, this.main, minSeq, this.bakeStart, false);
        this.bakeStart = minSeq;
      }
    }

    if (zoomDeferred || panDeferred || this.degraded || this.bakeStart > minSeq) {
      // without a scheduled frame the settle work (crisp exact-zoom rebuild,
      // trailing fold + target release) would wait for the next unrelated
      // invalidation
      this.settle.arm();
    }

    if (this.bakeStart > minSeq) {
      if (trailingDirty || !this.trailing.current || minSeq !== this.trailingStart || this.bakeStart !== this.trailingEnd) {
        this.renderTrailing(renderer, traceScene, minSeq, this.bakeStart);
      }
      this.trailingQuad.mesh.visible = true;
    } else {
      this.trailingQuad.mesh.visible = false;
      if (!evicting) this.trailing.release();
    }

    this.quad.mesh.visible = this.bakedEnd > this.bakeStart;
    return { scene: this.quadScene };
  }

  // Temporarily hides every live chunk outside [startSeq, endSeq) — the chunks' objects live in
  // one flat group, so toggling their visibility is enough.
  private withSeqRangeVisible(startSeq: number, endSeq: number, render: () => void): void {
    const live = this.liveChunks;
    const saved = this.visibilityScratch;
    saved.length = live.length;
    for (let i = 0; i < live.length; i++) {
      const object = live[i]!;
      saved[i] = object.visible;
      const seq = traceSequenceOf(object)!;
      if (seq < startSeq || seq >= endSeq) object.visible = false;
    }
    render();
    for (let i = 0; i < live.length; i++) live[i]!.visible = saved[i]!;
  }

  private renderSeqRange(renderer: WebGLRenderer, traceScene: Scene, target: OffscreenTarget, startSeq: number, endSeq: number, clear: boolean): void {
    // screen-space line widths are computed against the cache's own viewport
    target.renderInto(renderer, clear, () =>
      bakeTrace(() => this.withSeqRangeVisible(startSeq, endSeq, () => renderer.render(traceScene, this.cacheCamera)), { width: this.cachedCssWidth, height: this.cachedCssHeight }),
    );
  }

  private renderTrailing(renderer: WebGLRenderer, traceScene: Scene, startSeq: number, endSeq: number): void {
    // single-sample: this target re-renders on every eviction, where the MSAA clear/resolve
    // dominated steady-state cost on slower GL stacks; aliasing on the oldest translucent
    // chunks is not discernible
    this.trailing.ensure(this.cachedPixelWidth, this.cachedPixelHeight, 0);
    this.renderSeqRange(renderer, traceScene, this.trailing, startSeq, endSeq, true);
    this.trailingStart = startSeq;
    this.trailingEnd = endSeq;
    this.trailingQuad.mesh.position.copy(this.quad.mesh.position);
    this.trailingQuad.mesh.scale.copy(this.quad.mesh.scale);
  }

  private recache(renderer: WebGLRenderer, traceScene: Scene, view: ViewParams, degrade: boolean): void {
    // rebuilds while the view is moving or evictions are streaming skip multisampling: the MSAA
    // fill and resolve are what make a full rebuild blow the frame budget, and aliasing is not
    // discernible while the content or camera is churning; one crisp rebuild follows on settle
    const samples = degrade ? 0 : CACHE_SAMPLES;
    this.main.ensure(view.pixelWidth, view.pixelHeight, samples);
    this.degraded = samples === 0;

    // world extents derived from target pixels so the cache keeps exactly
    // the canvas's device pixels-per-world-unit (1:1 composite, no resample)
    const cssWidth = view.pixelWidth / view.dpr;
    const cssHeight = view.pixelHeight / view.dpr;
    const halfWidth = (cssWidth * view.unitsPerPixel) / 2;
    const halfHeight = (cssHeight * view.unitsPerPixel) / 2;

    const camera = this.cacheCamera;
    camera.left = -halfWidth;
    camera.right = halfWidth;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.position.set(view.centerX, view.centerY, 10);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    this.cachedCssWidth = cssWidth;
    this.cachedCssHeight = cssHeight;
    this.cachedPixelWidth = view.pixelWidth;
    this.cachedPixelHeight = view.pixelHeight;
    this.renderSeqRange(renderer, traceScene, this.main, this.bakeStart, this.bakedEnd, true);

    this.quad.mesh.position.set(view.centerX, view.centerY, 0);
    this.quad.mesh.scale.set(halfWidth * 2, halfHeight * 2, 1);

    this.cachedUnitsPerPixel = view.unitsPerPixel;
    this.cachedCenterX = view.centerX;
    this.cachedCenterY = view.centerY;
    this.cachedHalfWidth = halfWidth;
    this.cachedHalfHeight = halfHeight;
    this.fullRebuildNeeded = false;
  }

  dispose(): void {
    this.settle.dispose();
    this.main.release();
    this.trailing.release();
    this.quad.dispose();
    this.trailingQuad.dispose();
  }
}
