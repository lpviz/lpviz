import { restartableTimeout } from "@/features/core/timers";
import { type Object3D, Scene } from "three";
import { bakeTrace } from "../helpers/screenUniforms";
import { traceSequenceOf } from "./sequence";
import { CompositedTarget } from "./target";
import { PerspectiveView, PlanarView, type TraceFrame, type TraceView, VIEW_SETTLE_MS } from "./views";

// The trace render pass's stand-in: an accumulation buffer the chunks are baked into once.
// Trace chunks are immutable once appended, so the offscreen target is keyed by each chunk's append
// sequence number (see sequence.ts): appends draw only the new chunks into the existing
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

// match the antialiasing of the default framebuffer so cached strokes look
// identical to directly rendered ones
const CACHE_SAMPLES = 4;
const TRAILING_HEADROOM = 16;
// evictions arrive every few frames during rotation; a quiet half second
// means it stopped and the trailing chunks can be folded into the cache
const EVICTION_QUIET_MS = 500;
// Demand-driven rendering: a moving view needs one more frame once it settles (the crisp
// exact-zoom rebuild, the direct full-quality pass, the trailing fold) that nothing else would
// schedule; armed at most once at a time.
const SETTLE_FRAME_MS = Math.max(VIEW_SETTLE_MS, EVICTION_QUIET_MS / 2);

export class TraceCache {
  /** the scene the bakes composite through, in place of the trace pass; compiled ahead of the first trace */
  readonly scene = new Scene();
  // live chunks with seq in [main.start, main.end) are baked into the main target; live chunks
  // below main.start render through the trailing target
  private readonly main = new CompositedTarget();
  private readonly trailing = new CompositedTarget();
  private readonly planar = new PlanarView();
  private readonly perspective = new PerspectiveView();
  // the mode's view the bake is anchored by, null before the first
  private view: TraceView | null = null;
  private contentDirty = true;
  private lastMinSeq = -1;
  private lastEvictionAt = -Infinity;
  private degraded = false;
  private readonly settle = restartableTimeout();
  private liveChunks: Object3D[] = [];
  private visibilityScratch: boolean[] = [];

  constructor(private readonly requestFrame: () => void) {
    this.trailing.mesh.renderOrder = 1;
    this.scene.add(this.main.mesh, this.trailing.mesh);
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
    this.main.mesh.visible = false;
    this.trailing.mesh.visible = false;
    this.trailing.release();
    return null;
  }

  // Prepares the stand-in for the trace pass. Returns the scene with the composite quads (the
  // caller renders it in place of the pass), or null when the pass must render directly.
  prepare(frame: TraceFrame): Scene | null {
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
    const { main, trailing, liveChunks: live } = this;

    const now = performance.now();
    const evicting = this.trackEvictions(now, minSeq);
    const contentRebuild = this.contentDirty || !main.current || minSeq > main.start;
    const fit = view.fit(frame, now, !contentRebuild);

    let trailingDirty = false;
    if (contentRebuild || fit.rebuild || (this.degraded && !fit.moving && !evicting)) {
      // under active eviction, leave the oldest chunks out of the bake so
      // the next evictions don't each force another full rebuild
      const headroom = evicting ? Math.min(TRAILING_HEADROOM, live.length >> 2) : 0;
      main.start = minSeq + headroom;
      main.end = maxSeq + 1;
      view.place(main, trailing, fit.moving);
      this.recache(frame, fit.moving || evicting);
      trailingDirty = true;
    } else {
      if (maxSeq >= main.end) {
        // new chunks: accumulate into the existing target without clearing
        this.renderSeqRange(frame, main, main.end, maxSeq + 1, false);
        main.end = maxSeq + 1;
      }
      if (main.start > minSeq && !evicting) {
        // evictions stopped: fold the trailing chunks into the main bake so
        // the trailing target can be released
        this.renderSeqRange(frame, main, minSeq, main.start, false);
        main.start = minSeq;
      }
    }

    if (fit.settling || this.degraded || main.start > minSeq) {
      // without a scheduled frame the settle work (crisp exact-zoom rebuild,
      // trailing fold + target release) would wait for the next unrelated
      // invalidation
      if (!this.settle.pending) this.settle.schedule(this.requestFrame, SETTLE_FRAME_MS);
    }

    if (main.start > minSeq) {
      if (trailingDirty || !trailing.current || minSeq !== trailing.start || main.start !== trailing.end) {
        this.renderTrailing(frame, minSeq, main.start);
      }
      trailing.mesh.visible = true;
    } else {
      trailing.mesh.visible = false;
      if (!evicting) trailing.release();
    }

    main.mesh.visible = main.end > main.start;
    return this.scene;
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
  private renderSeqRange(frame: TraceFrame, target: CompositedTarget, startSeq: number, endSeq: number, clear: boolean): void {
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
    this.trailing.start = startSeq;
    this.trailing.end = endSeq;
  }

  private recache(frame: TraceFrame, degrade: boolean): void {
    const view = this.view!;
    const samples = degrade ? 0 : CACHE_SAMPLES;
    this.main.ensure(view.pixelWidth, view.pixelHeight, samples, view.depth);
    this.degraded = samples === 0;
    this.renderSeqRange(frame, this.main, this.main.start, this.main.end, true);
    this.contentDirty = false;
  }

  dispose(): void {
    this.settle.clear();
    this.main.dispose();
    this.trailing.dispose();
  }
}
