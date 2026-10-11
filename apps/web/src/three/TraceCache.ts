import type { Camera, Object3D, WebGLRenderer } from "three";
import { Material, type Mesh, OrthographicCamera, Scene } from "three";
import { bakeTrace } from "./helpers/pathRibbon";
import { CompositeQuad, OffscreenTarget, SettleTimer, type TraceFrame, type TraceImpostor, type TracePassImpostor, VIEW_SETTLE_MS, ViewMotion } from "./helpers/traceComposite";
import { traceSequenceOf } from "./helpers/traceSequence";
import { TRACE_OCCLUDER_LAYER } from "./Layer";

// The impostor for the trace render pass: an accumulation buffer the chunks are baked into once.
// Trace chunks are immutable once appended, so the offscreen target is keyed by each chunk's append
// sequence number (see traceSequence.ts): appends draw only the new chunks into the existing
// target with no clear (alpha-over of one shared color and opacity is associative, so neither
// chunk order nor the order of the two composite quads changes the blend). Evictions cannot be
// un-blended, so a rebuild leaves the oldest TRAILING_HEADROOM chunks out of the main bake and
// renders them through a trailing target that re-renders only when an eviction shrinks it; once
// evictions stop they are folded into the main target. Both targets render through the same
// camera, viewport and shader path, so a chunk is pixel-identical wherever it lives.
//
// Where the bake is anchored is the view's: in 2D a world rect around the visible one (PlanarView),
// kept across pans within its margin and small mid-gesture zooms; in 3D the canvas itself through
// the frame's camera (PerspectiveView), with the depth primed by the geometry that occludes the
// trace, redone whenever the view or that geometry changes. Rebuilds while the view is moving or
// evictions are streaming skip multisampling: the MSAA fill and resolve are what make a full
// rebuild blow the frame budget, and aliasing is not discernible while the content or camera is
// churning; one crisp rebuild follows on settle.
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

/** Where this frame's view stands against the bake: whether it must be redone, whether the view is moving, and whether a settle frame is owed. */
type Fit = { rebuild: boolean; moving: boolean; settling: boolean };

/** How a mode anchors the bake: the camera to bake with, the target's size, and the quads' placement. */
interface TraceView {
  /** the camera the chunks bake through */
  readonly camera: Camera;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  /** the CSS size screen-space stroke widths are computed against; the canvas's own when absent */
  readonly cssSize: { width: number; height: number } | undefined;
  /** whether the bake needs a depth buffer (3D: chunks and the floor occlude) */
  readonly depth: boolean;
  /** Read the frame; `mayDefer` says nothing else forces a rebuild, so a mid-gesture pan or zoom may wait. */
  fit(frame: TraceFrame, now: number, mayDefer: boolean): Fit;
  /** Anchor the camera and the quads for a rebuild from the frame last fitted. */
  place(main: CompositeQuad, trailing: CompositeQuad, moving: boolean): void;
  /** Prime a cleared target's depth with the geometry that occludes the trace. */
  primeDepth?(renderer: WebGLRenderer, frame: TraceFrame): void;
}

type PlanarParams = {
  width: number;
  height: number;
  unitsPerPixel: number;
  dpr: number;
  pixelWidth: number;
  pixelHeight: number;
  centerX: number;
  centerY: number;
  halfVisibleWidth: number;
  halfVisibleHeight: number;
  now: number;
};

// The 2D bake: a world-anchored rect covering the visible one plus a pan margin at the canvas's
// device pixels-per-world-unit, fully rebuilt on a zoom change, a pan beyond the margin or a
// resize. Zoom rebuilds are deferred while the zoom is changing: the quads are world-anchored, so
// only the screen-space stroke width drifts, until the drift passes ZOOM_REBUILD_RATIO, the view
// escapes the cached rect, or the view is quiet for VIEW_SETTLE_MS.
class PlanarView implements TraceView {
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  pixelWidth = 0;
  pixelHeight = 0;
  cssSize = { width: 0, height: 0 };
  readonly depth = false;
  // the view as [unitsPerPixel, centerX, centerY]
  private readonly motion = new ViewMotion(3);
  private params: PlanarParams | null = null;
  private lastRebuildAt = -Infinity;
  private panVelocityX = 0;
  private panVelocityY = 0;
  private cachedUnitsPerPixel = 0;
  private cachedCenterX = 0;
  private cachedCenterY = 0;
  private cachedHalfWidth = 0;
  private cachedHalfHeight = 0;

  fit(frame: TraceFrame, now: number, mayDefer: boolean): Fit {
    const { snapshot, renderer } = frame;
    const width = snapshot.width || 1;
    const height = snapshot.height || 1;
    const unitsPerPixel = snapshot.unitsPerPixel;
    const dpr = renderer.getPixelRatio();
    const params: PlanarParams = {
      width,
      height,
      unitsPerPixel,
      dpr,
      pixelWidth: Math.min(MAX_CACHE_DIMENSION, Math.ceil(width * CACHE_MARGIN * dpr)),
      pixelHeight: Math.min(MAX_CACHE_DIMENSION, Math.ceil(height * CACHE_MARGIN * dpr)),
      centerX: snapshot.target.x,
      centerY: snapshot.target.y,
      halfVisibleWidth: (width * unitsPerPixel) / 2,
      halfVisibleHeight: (height * unitsPerPixel) / 2,
      now,
    };
    this.params = params;
    const { centerX, centerY, halfVisibleWidth, halfVisibleHeight, pixelWidth, pixelHeight } = params;

    const panContained =
      centerX + halfVisibleWidth <= this.cachedCenterX + this.cachedHalfWidth &&
      centerX - halfVisibleWidth >= this.cachedCenterX - this.cachedHalfWidth &&
      centerY + halfVisibleHeight <= this.cachedCenterY + this.cachedHalfHeight &&
      centerY - halfVisibleHeight >= this.cachedCenterY - this.cachedHalfHeight;

    const previousCenterX = this.motion.previous(1);
    const previousCenterY = this.motion.previous(2);
    if (this.motion.update(now, [unitsPerPixel, centerX, centerY])) {
      // smoothed per-frame pan velocity, used to lead rebuilt rects
      this.panVelocityX = 0.6 * this.panVelocityX + 0.4 * (Number.isNaN(previousCenterX) ? 0 : centerX - previousCenterX);
      this.panVelocityY = 0.6 * this.panVelocityY + 0.4 * (Number.isNaN(previousCenterY) ? 0 : centerY - previousCenterY);
    }
    const moving = this.motion.moving(now);
    if (!moving) {
      this.panVelocityX = 0;
      this.panVelocityY = 0;
    }

    const zoomChanged = unitsPerPixel !== this.cachedUnitsPerPixel;
    const zoomRatio = this.cachedUnitsPerPixel > 0 ? this.cachedUnitsPerPixel / unitsPerPixel : 1;
    const zoomDeferred = zoomChanged && moving && zoomRatio < ZOOM_REBUILD_RATIO && zoomRatio > 1 / ZOOM_REBUILD_RATIO;
    const sizeChanged = pixelWidth !== this.pixelWidth || pixelHeight !== this.pixelHeight;
    const panDeferred = !panContained && moving && now - this.lastRebuildAt < PAN_REBUILD_INTERVAL_MS && mayDefer && !sizeChanged && (!zoomChanged || zoomDeferred);
    return { rebuild: (zoomChanged && !zoomDeferred) || sizeChanged || (!panContained && !panDeferred), moving, settling: zoomDeferred || panDeferred };
  }

  place(main: CompositeQuad, trailing: CompositeQuad, moving: boolean): void {
    const view = this.params!;
    // lead the pan direction so a sustained drag escapes the margin less
    // often; capped so the visible rect stays inside the rebuilt rect
    const slackX = ((view.pixelWidth / view.dpr) * view.unitsPerPixel) / 2 - view.halfVisibleWidth;
    const slackY = ((view.pixelHeight / view.dpr) * view.unitsPerPixel) / 2 - view.halfVisibleHeight;
    const clampLead = (lead: number, slack: number) => Math.max(-slack * 0.8, Math.min(slack * 0.8, lead));
    const centerX = view.centerX + (moving ? clampLead(this.panVelocityX * PAN_LEAD_FRAMES, slackX) : 0);
    const centerY = view.centerY + (moving ? clampLead(this.panVelocityY * PAN_LEAD_FRAMES, slackY) : 0);
    this.lastRebuildAt = view.now;

    // world extents derived from target pixels so the cache keeps exactly
    // the canvas's device pixels-per-world-unit (1:1 composite, no resample)
    const cssWidth = view.pixelWidth / view.dpr;
    const cssHeight = view.pixelHeight / view.dpr;
    const halfWidth = (cssWidth * view.unitsPerPixel) / 2;
    const halfHeight = (cssHeight * view.unitsPerPixel) / 2;

    const { camera } = this;
    camera.left = -halfWidth;
    camera.right = halfWidth;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.position.set(centerX, centerY, 10);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    this.cssSize = { width: cssWidth, height: cssHeight };
    this.pixelWidth = view.pixelWidth;
    this.pixelHeight = view.pixelHeight;
    main.placeInWorld(centerX, centerY, halfWidth * 2, halfHeight * 2);
    trailing.placeInWorld(centerX, centerY, halfWidth * 2, halfHeight * 2);

    this.cachedUnitsPerPixel = view.unitsPerPixel;
    this.cachedCenterX = centerX;
    this.cachedCenterY = centerY;
    this.cachedHalfWidth = halfWidth;
    this.cachedHalfHeight = halfHeight;
  }
}

// The 3D bake: the canvas itself through the frame's perspective camera. A perspective view cannot
// keep a bake across camera motion (parallax), so any change of the view redoes it, single-sample
// while the motion lasts; a still view accumulates appends against the depth primed from the
// geometry that occludes the trace (see TRACE_OCCLUDER_LAYER), redone when that geometry changes.
class PerspectiveView implements TraceView {
  camera!: Camera;
  pixelWidth = 0;
  pixelHeight = 0;
  readonly cssSize = undefined;
  readonly depth = true;
  // the view as the numbers that place the camera: position, up, fov, aspect, target, the z scale and flatten
  private readonly motion = new ViewMotion(13);
  // what the occluding geometry is rebuilt from
  private occluders: readonly unknown[] = [];
  private materialScratch: Material[] = [];

  fit(frame: TraceFrame, now: number): Fit {
    const { renderer, camera, snapshot, state } = frame;
    this.camera = camera;
    const p = snapshot.perspective;
    const t = snapshot.target;
    const posed = this.motion.update(now, [p.position.x, p.position.y, p.position.z, p.up.x, p.up.y, p.up.z, p.fov, p.aspect, t.x, t.y, t.z, state.zScale, snapshot.transitionZMultiplier]);
    const moving = state.isTransitioning3D || this.motion.moving(now);
    const occluders = [state.vertices, state.polytope, state.completionMode];
    const occludersChanged = occluders.some((input, i) => !Object.is(input, this.occluders[i]));
    this.occluders = occluders;
    const pixelWidth = Math.max(1, Math.round((snapshot.width || 1) * renderer.getPixelRatio()));
    const pixelHeight = Math.max(1, Math.round((snapshot.height || 1) * renderer.getPixelRatio()));
    const sizeChanged = pixelWidth !== this.pixelWidth || pixelHeight !== this.pixelHeight;
    this.pixelWidth = pixelWidth;
    this.pixelHeight = pixelHeight;
    return { rebuild: posed || occludersChanged || sizeChanged, moving, settling: moving };
  }

  place(main: CompositeQuad, trailing: CompositeQuad): void {
    main.placeOnScreen();
    trailing.placeOnScreen();
  }

  // Depth-only render of the occluders, so geometry hides the chunks baked after it as in a direct
  // draw: the camera sees the occluder layer alone, the materials write no color.
  primeDepth(renderer: WebGLRenderer, { camera, occluders }: TraceFrame): void {
    const touched = this.materialScratch;
    const layers = camera.layers.mask;
    camera.layers.set(TRACE_OCCLUDER_LAYER);
    for (const scene of occluders) {
      touched.length = 0;
      scene.traverse((object) => {
        const material = (object as Mesh).material as Material | undefined;
        if (material instanceof Material && object.layers.test(camera.layers) && material.depthWrite && material.colorWrite) {
          material.colorWrite = false;
          touched.push(material);
        }
      });
      if (touched.length > 0) renderer.render(scene, camera);
      for (const material of touched) material.colorWrite = true;
    }
    touched.length = 0;
    camera.layers.mask = layers;
  }
}

export class TraceCache implements TraceImpostor {
  readonly scene = new Scene();
  private readonly quad = new CompositeQuad();
  private readonly trailingQuad = new CompositeQuad();
  private readonly main = new OffscreenTarget(this.quad);
  private readonly trailing = new OffscreenTarget(this.trailingQuad);
  private readonly planar = new PlanarView();
  private readonly perspective = new PerspectiveView();
  // the mode's view the bake is anchored by, null before the first
  private view: TraceView | null = null;
  private contentDirty = true;
  // live chunks with seq in [bakeStart, bakedEnd) are baked into the main
  // target; live chunks below bakeStart render through the trailing target
  private bakeStart = 0;
  private bakedEnd = 0;
  private trailingStart = 0;
  private trailingEnd = 0;
  private lastMinSeq = -1;
  private lastEvictionAt = -Infinity;
  private degraded = false;
  private settle: SettleTimer;
  private liveChunks: Object3D[] = [];
  private visibilityScratch: boolean[] = [];

  constructor(requestFrame: () => void) {
    this.settle = new SettleTimer(requestFrame, Math.max(VIEW_SETTLE_MS, EVICTION_QUIET_MS / 2));
    this.trailingQuad.mesh.renderOrder = 1;
    this.scene.add(this.quad.mesh, this.trailingQuad.mesh);
  }

  markContentDirty(): void {
    this.contentDirty = true;
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

  // Whether chunks were evicted recently, as the rebuild policy reads it.
  private trackEvictions(now: number, minSeq: number): boolean {
    if (minSeq > this.lastMinSeq && this.lastMinSeq >= 0) {
      this.lastEvictionAt = now;
    }
    this.lastMinSeq = minSeq;
    return now - this.lastEvictionAt < EVICTION_QUIET_MS;
  }

  // the pass renders directly this frame; the next bake starts over
  private drop(): null {
    this.contentDirty = true;
    this.quad.mesh.visible = false;
    this.trailingQuad.mesh.visible = false;
    this.trailing.release();
    return null;
  }

  // Prepares the impostor for the trace pass. Returns the scene with the composite quads (the
  // caller renders it in place of the pass), or null when the pass must render directly.
  prepare(frame: TraceFrame): TracePassImpostor | null {
    const { snapshot, state, trace: traceScene } = frame;
    // a to-2D transition's last frames are planar but still moving: drawn directly, nothing kept
    if (snapshot.mode === "2d" && state.isTransitioning3D) return this.drop();
    const view = snapshot.mode === "2d" ? this.planar : this.perspective;
    if (view !== this.view) {
      // a bake never survives a round trip through the other mode
      this.view = view;
      this.contentDirty = true;
    }

    const chunks = this.collectLiveChunks(traceScene);
    if (!chunks) return this.drop();
    const { minSeq, maxSeq } = chunks;
    const live = this.liveChunks;

    const now = performance.now();
    const evicting = this.trackEvictions(now, minSeq);
    const contentRebuild = this.contentDirty || !this.main.current || minSeq > this.bakeStart;
    const fit = view.fit(frame, now, !contentRebuild);

    let trailingDirty = false;
    if (contentRebuild || fit.rebuild || (this.degraded && !fit.moving && !evicting)) {
      // under active eviction, leave the oldest chunks out of the bake so
      // the next evictions don't each force another full rebuild
      const headroom = evicting ? Math.min(TRAILING_HEADROOM, live.length >> 2) : 0;
      this.bakeStart = minSeq + headroom;
      this.bakedEnd = maxSeq + 1;
      view.place(this.quad, this.trailingQuad, fit.moving);
      this.recache(frame, fit.moving || evicting);
      trailingDirty = true;
    } else {
      if (maxSeq >= this.bakedEnd) {
        // new chunks: accumulate into the existing target without clearing
        this.renderSeqRange(frame, this.main, this.bakedEnd, maxSeq + 1, false);
        this.bakedEnd = maxSeq + 1;
      }
      if (this.bakeStart > minSeq && !evicting) {
        // evictions stopped: fold the trailing chunks into the main bake so
        // the trailing target can be released
        this.renderSeqRange(frame, this.main, minSeq, this.bakeStart, false);
        this.bakeStart = minSeq;
      }
    }

    if (fit.settling || this.degraded || this.bakeStart > minSeq) {
      // without a scheduled frame the settle work (crisp exact-zoom rebuild,
      // trailing fold + target release) would wait for the next unrelated
      // invalidation
      this.settle.arm();
    }

    if (this.bakeStart > minSeq) {
      if (trailingDirty || !this.trailing.current || minSeq !== this.trailingStart || this.bakeStart !== this.trailingEnd) {
        this.renderTrailing(frame, minSeq, this.bakeStart);
      }
      this.trailingQuad.mesh.visible = true;
    } else {
      this.trailingQuad.mesh.visible = false;
      if (!evicting) this.trailing.release();
    }

    this.quad.mesh.visible = this.bakedEnd > this.bakeStart;
    return { scene: this.scene };
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

  // The chunks in [startSeq, endSeq) into the target: appended, or (clear) onto a fresh bake whose
  // depth the view primes first. Screen-space line widths are computed against the bake's own size.
  private renderSeqRange(frame: TraceFrame, target: OffscreenTarget, startSeq: number, endSeq: number, clear: boolean): void {
    const { renderer, trace } = frame;
    const view = this.view!;
    target.renderInto(renderer, clear, () => {
      if (clear) view.primeDepth?.(renderer, frame);
      bakeTrace(() => this.withSeqRangeVisible(startSeq, endSeq, () => renderer.render(trace, view.camera)), view.cssSize);
    });
  }

  private renderTrailing(frame: TraceFrame, startSeq: number, endSeq: number): void {
    // single-sample: this target re-renders on every eviction, where the MSAA clear/resolve
    // dominated steady-state cost on slower GL stacks; aliasing on the oldest translucent
    // chunks is not discernible
    const view = this.view!;
    this.trailing.ensure(view.pixelWidth, view.pixelHeight, 0, view.depth);
    this.renderSeqRange(frame, this.trailing, startSeq, endSeq, true);
    this.trailingStart = startSeq;
    this.trailingEnd = endSeq;
  }

  private recache(frame: TraceFrame, degrade: boolean): void {
    const view = this.view!;
    const samples = degrade ? 0 : CACHE_SAMPLES;
    this.main.ensure(view.pixelWidth, view.pixelHeight, samples, view.depth);
    this.degraded = samples === 0;
    this.renderSeqRange(frame, this.main, this.bakeStart, this.bakedEnd, true);
    this.contentDirty = false;
  }

  dispose(): void {
    this.settle.dispose();
    this.main.release();
    this.trailing.release();
    this.quad.dispose();
    this.trailingQuad.dispose();
  }
}
