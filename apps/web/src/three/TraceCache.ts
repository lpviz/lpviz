import { getState } from "@/features/core/store";
import { getViewportRenderSnapshot } from "@/features/viewport/runtime/snapshot";
import { Mesh, Object3D, OrthographicCamera, Scene, ShaderMaterial, WebGLRenderer, WebGLRenderTarget } from "three";
import { setPathRibbonCacheEncode, setPathRibbonResolution } from "./helpers/pathRibbon";
import { makeCompositeQuad, SettleTimer } from "./helpers/traceComposite";

// World-anchored impostor for the trace-lines render pass in 2D mode.
//
// Trace chunks are immutable once appended, so the cache treats its offscreen
// target as an accumulation buffer keyed by each chunk's append sequence
// number (stamped on its mesh by TraceLineLayer):
//
//  - Appends are incremental: only the new chunks are drawn into the existing
//    target, with no clear — alpha-over compositing into the target is
//    associative, so the result is identical to re-rendering everything.
//  - Evictions cannot be un-blended, so they are amortized instead of paid
//    per step: a rebuild bakes all live chunks except the oldest few
//    (TRAILING_HEADROOM), which render through a second, trailing target
//    that re-renders only when an eviction shrinks it. The next rebuild is
//    only needed once that headroom of evictions is used up. During
//    continuous objective rotation — one eviction per step at trace
//    capacity — this turns "redraw every chunk every step" into "draw one
//    new chunk plus the trailing few, and a full rebuild every ~headroom
//    steps".
//  - Once evictions stop, the trailing chunks are folded into the main
//    target (also incrementally — adding is always safe) and the trailing
//    target is released.
//
// Both targets render through the same camera, viewport, and shader path, so
// a chunk produces bit-identical pixels wherever it currently lives — moving
// chunks between the targets can never make strokes shimmer. Camera frames
// composite the two targets as world-anchored quads; trace strokes all share
// one color and opacity, so the quad order does not affect the blended
// result (alpha-over of equal colors commutes).
//
// The cache covers the visible rect plus a pan margin at the canvas's device
// pixels-per-world-unit; it fully rebuilds when the zoom level changes, the
// view pans beyond the margin, the canvas resizes, or after a round trip
// through 3D (a perspective view cannot composite from an orthographic
// billboard).
//
// Zoom rebuilds are deferred while the zoom level is actively changing: the
// quads are world-anchored, so the camera scales them correctly by itself
// and only the constant screen-space stroke width drifts (rebuilding every
// gesture frame redraws every chunk and is the single biggest frame-drop
// source). The cache re-crisps when the drift passes ZOOM_REBUILD_RATIO,
// when the view escapes the cached rect, or once the zoom is quiet for
// ZOOM_SETTLE_MS.
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
const VIEW_SETTLE_MS = 160;
// fast pans can escape the margin every couple of frames; mid-gesture the
// rebuilds are rate limited (the world-anchored quads keep compositing, so
// only the freshly exposed strip lacks trace history until the next rebuild)
// and each rebuilt rect leads the pan direction to make escapes rarer
const PAN_REBUILD_INTERVAL_MS = 120;
const PAN_LEAD_FRAMES = 12;

const QUAD_VERTEX_SHADER = /* glsl */ `
out vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

function getTraceSeq(object: Object3D): number | undefined {
  return object.userData.traceSeq as number | undefined;
}

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

export class TraceCache {
  private renderTarget: WebGLRenderTarget | null = null;
  private trailingTarget: WebGLRenderTarget | null = null;
  private cacheCamera = new OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  private quadScene = new Scene();
  private quad: Mesh;
  private quadMaterial: ShaderMaterial;
  private trailingQuad: Mesh;
  private trailingMaterial: ShaderMaterial;
  private fullRebuildNeeded = true;
  // live chunks with seq in [bakeStart, bakedEnd) are baked into the main
  // target; live chunks below bakeStart render through the trailing target
  private bakeStart = 0;
  private bakedEnd = 0;
  private trailingStart = 0;
  private trailingEnd = 0;
  private lastMinSeq = -1;
  private lastEvictionAt = -Infinity;
  private lastSeenUnitsPerPixel = 0;
  private lastSeenCenterX = NaN;
  private lastSeenCenterY = NaN;
  private lastViewChangeAt = -Infinity;
  private lastRebuildAt = -Infinity;
  private panVelocityX = 0;
  private panVelocityY = 0;
  private degraded = false;
  private settle: SettleTimer;
  private liveMeshes: Mesh[] = [];
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
    const main = makeCompositeQuad(QUAD_VERTEX_SHADER, 1);
    this.quad = main.mesh;
    this.quadMaterial = main.material;
    const trailing = makeCompositeQuad(QUAD_VERTEX_SHADER, 1);
    this.trailingQuad = trailing.mesh;
    this.trailingMaterial = trailing.material;
    this.trailingQuad.renderOrder = 1;
    this.quadScene.add(this.quad, this.trailingQuad);
  }

  markContentDirty(): void {
    this.fullRebuildNeeded = true;
  }

  // Prepares the impostor for the trace-lines pass. Returns the scene with
  // the composite quads (the caller renders it in place of the pass), or
  // null when the pass must render directly.
  prepare(renderer: WebGLRenderer, traceLinesScene: Scene): Scene | null {
    const snapshot = getViewportRenderSnapshot();
    if (snapshot.mode !== "2d" || getState().isTransitioning3D) {
      // keep a stale billboard from surviving a round trip through 3D
      this.fullRebuildNeeded = true;
      return null;
    }

    const live = this.liveMeshes;
    live.length = 0;
    let minSeq = Infinity;
    let maxSeq = -Infinity;
    traceLinesScene.traverseVisible((object) => {
      const seq = getTraceSeq(object);
      if (seq === undefined) return;
      live.push(object as Mesh);
      if (seq < minSeq) minSeq = seq;
      if (seq > maxSeq) maxSeq = seq;
    });
    if (live.length === 0) {
      this.fullRebuildNeeded = true;
      this.quad.visible = false;
      this.trailingQuad.visible = false;
      this.releaseTrailingTarget();
      return null;
    }

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
    if (minSeq > this.lastMinSeq && this.lastMinSeq >= 0) {
      this.lastEvictionAt = now;
    }
    this.lastMinSeq = minSeq;
    const evicting = now - this.lastEvictionAt < EVICTION_QUIET_MS;

    if (unitsPerPixel !== this.lastSeenUnitsPerPixel || centerX !== this.lastSeenCenterX || centerY !== this.lastSeenCenterY) {
      // smoothed per-frame pan velocity, used to lead rebuilt rects
      this.panVelocityX = 0.6 * this.panVelocityX + 0.4 * (Number.isNaN(this.lastSeenCenterX) ? 0 : centerX - this.lastSeenCenterX);
      this.panVelocityY = 0.6 * this.panVelocityY + 0.4 * (Number.isNaN(this.lastSeenCenterY) ? 0 : centerY - this.lastSeenCenterY);
      this.lastViewChangeAt = now;
      this.lastSeenUnitsPerPixel = unitsPerPixel;
      this.lastSeenCenterX = centerX;
      this.lastSeenCenterY = centerY;
    }
    const viewMoving = now - this.lastViewChangeAt < VIEW_SETTLE_MS;
    if (!viewMoving) {
      this.panVelocityX = 0;
      this.panVelocityY = 0;
    }
    const zoomRatio = this.cachedUnitsPerPixel > 0 ? this.cachedUnitsPerPixel / unitsPerPixel : 1;
    const zoomDeferred = unitsPerPixel !== this.cachedUnitsPerPixel && viewMoving && zoomRatio < ZOOM_REBUILD_RATIO && zoomRatio > 1 / ZOOM_REBUILD_RATIO;
    const panDeferred =
      !panContained &&
      viewMoving &&
      now - this.lastRebuildAt < PAN_REBUILD_INTERVAL_MS &&
      this.renderTarget !== null &&
      !this.fullRebuildNeeded &&
      pixelWidth === this.cachedPixelWidth &&
      pixelHeight === this.cachedPixelHeight &&
      (unitsPerPixel === this.cachedUnitsPerPixel || zoomDeferred) &&
      minSeq <= this.bakeStart;

    let trailingDirty = false;
    if (
      this.fullRebuildNeeded ||
      !this.renderTarget ||
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
        traceLinesScene,
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
        this.renderSeqRange(renderer, traceLinesScene, this.renderTarget, this.bakedEnd, maxSeq + 1, false);
        this.bakedEnd = maxSeq + 1;
      }
      if (this.bakeStart > minSeq && !evicting) {
        // evictions stopped: fold the trailing chunks into the main bake so
        // the trailing target can be released
        this.renderSeqRange(renderer, traceLinesScene, this.renderTarget, minSeq, this.bakeStart, false);
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
      if (trailingDirty || !this.trailingTarget || minSeq !== this.trailingStart || this.bakeStart !== this.trailingEnd) {
        this.renderTrailing(renderer, traceLinesScene, minSeq, this.bakeStart);
      }
      this.trailingQuad.visible = true;
    } else {
      this.trailingQuad.visible = false;
      if (!evicting) this.releaseTrailingTarget();
    }

    this.quad.visible = this.bakedEnd > this.bakeStart;
    return this.quadScene;
  }

  // Temporarily hides every live chunk outside [startSeq, endSeq) — the
  // chunks live in one flat group, so toggling mesh visibility is enough.
  private withSeqRangeVisible(startSeq: number, endSeq: number, render: () => void): void {
    const live = this.liveMeshes;
    const saved = this.visibilityScratch;
    saved.length = live.length;
    for (let i = 0; i < live.length; i++) {
      const mesh = live[i]!;
      saved[i] = mesh.visible;
      const seq = getTraceSeq(mesh)!;
      if (seq < startSeq || seq >= endSeq) mesh.visible = false;
    }
    render();
    for (let i = 0; i < live.length; i++) live[i]!.visible = saved[i]!;
  }

  private renderSeqRange(renderer: WebGLRenderer, traceLinesScene: Scene, target: WebGLRenderTarget, startSeq: number, endSeq: number, clear: boolean): void {
    // screen-space line widths must be computed against the cache viewport
    setPathRibbonResolution(this.cachedCssWidth, this.cachedCssHeight);
    setPathRibbonCacheEncode(true);
    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    if (clear) renderer.clear();
    this.withSeqRangeVisible(startSeq, endSeq, () => {
      renderer.render(traceLinesScene, this.cacheCamera);
    });
    renderer.setRenderTarget(previousTarget);
    setPathRibbonCacheEncode(false);
    const snapshot = getViewportRenderSnapshot();
    setPathRibbonResolution(snapshot.width || 1, snapshot.height || 1);
  }

  private renderTrailing(renderer: WebGLRenderer, traceLinesScene: Scene, startSeq: number, endSeq: number): void {
    if (!this.trailingTarget || this.trailingTarget.width !== this.cachedPixelWidth || this.trailingTarget.height !== this.cachedPixelHeight) {
      this.trailingTarget?.dispose();
      // single-sample: this target re-renders on every eviction (the most
      // frequent cache operation during rotation), the MSAA clear/resolve
      // there dominated steady-state cost on slower GL stacks, and the
      // aliasing on the oldest translucent chunks is not discernible
      this.trailingTarget = new WebGLRenderTarget(this.cachedPixelWidth, this.cachedPixelHeight, { samples: 0, depthBuffer: false, stencilBuffer: false });
      this.trailingMaterial.uniforms.map!.value = this.trailingTarget.texture;
    }
    this.renderSeqRange(renderer, traceLinesScene, this.trailingTarget, startSeq, endSeq, true);
    this.trailingStart = startSeq;
    this.trailingEnd = endSeq;
    this.trailingQuad.position.copy(this.quad.position);
    this.trailingQuad.scale.copy(this.quad.scale);
  }

  private releaseTrailingTarget(): void {
    if (!this.trailingTarget) return;
    this.trailingTarget.dispose();
    this.trailingTarget = null;
    this.trailingMaterial.uniforms.map!.value = null;
  }

  private recache(renderer: WebGLRenderer, traceLinesScene: Scene, view: ViewParams, degrade: boolean): void {
    // rebuilds while the view is moving or evictions are streaming (sustained
    // rotation at trace capacity) skip multisampling: the MSAA fill and
    // resolve are what makes a full rebuild blow the frame budget, and
    // aliasing is not discernible while the content or camera is churning.
    // One crisp rebuild follows once everything settles.
    const samples = degrade ? 0 : CACHE_SAMPLES;
    if (!this.renderTarget || this.renderTarget.width !== view.pixelWidth || this.renderTarget.height !== view.pixelHeight || this.renderTarget.samples !== samples) {
      this.renderTarget?.dispose();
      this.renderTarget = new WebGLRenderTarget(view.pixelWidth, view.pixelHeight, {
        samples,
        depthBuffer: false,
        stencilBuffer: false,
      });
      this.quadMaterial.uniforms.map!.value = this.renderTarget.texture;
    }
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
    this.renderSeqRange(renderer, traceLinesScene, this.renderTarget, this.bakeStart, this.bakedEnd, true);

    this.quad.position.set(view.centerX, view.centerY, 0);
    this.quad.scale.set(halfWidth * 2, halfHeight * 2, 1);

    this.cachedUnitsPerPixel = view.unitsPerPixel;
    this.cachedCenterX = view.centerX;
    this.cachedCenterY = view.centerY;
    this.cachedHalfWidth = halfWidth;
    this.cachedHalfHeight = halfHeight;
    this.fullRebuildNeeded = false;
  }

  dispose(): void {
    this.settle.dispose();
    this.renderTarget?.dispose();
    this.renderTarget = null;
    this.releaseTrailingTarget();
    this.quad.geometry.dispose();
    this.quadMaterial.dispose();
    this.trailingQuad.geometry.dispose();
    this.trailingMaterial.dispose();
  }
}
