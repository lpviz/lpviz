import type { State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { type Camera, Material, type Mesh, OrthographicCamera, type Scene, type WebGLRenderer } from "three";
import { TRACE_OCCLUDER_LAYER } from "../Layer";
import type { CompositedTarget } from "./target";

/** What the trace pass is handed each frame: the renderer and camera, the frame's inputs, the pass's scene and the scenes that occlude it. */
export type TraceFrame = { renderer: WebGLRenderer; camera: Camera; state: State; snapshot: ViewportRenderSnapshot; trace: Scene; occluders: readonly Scene[] };

// how long after its last change a view counts as moving
export const VIEW_SETTLE_MS = 160;
const CACHE_MARGIN = 1.25;
const MAX_CACHE_DIMENSION = 8192;
// mid-gesture stroke-width drift allowed before a rebuild re-crisps anyway
const ZOOM_REBUILD_RATIO = 1.25;
// fast pans can escape the margin every couple of frames; mid-gesture the rebuilds are rate
// limited (the world-anchored quads keep compositing, so only the freshly exposed strip lacks
// trace history) and each rebuilt rect leads the pan direction to make escapes rarer
const PAN_REBUILD_INTERVAL_MS = 120;
const PAN_LEAD_FRAMES = 12;

/**
 * Whether the view is in motion, as the trace cache decides it: the numbers that place the view are
 * recorded each frame, and the view counts as moving for VIEW_SETTLE_MS after they last changed.
 */
class ViewMotion {
  private readonly last: Float64Array;
  private lastChangeAt = -Infinity;

  constructor(size: number) {
    this.last = new Float64Array(size).fill(NaN);
  }

  /** The view's number `i` as of the last frame recorded (NaN before the first). */
  previous(i: number): number {
    return this.last[i]!;
  }

  /** Record this frame's view; true when it differs from the last. */
  update(now: number, view: readonly number[]): boolean {
    let changed = false;
    for (let i = 0; i < view.length; i++) {
      if (view[i] === this.last[i]) continue;
      this.last[i] = view[i]!;
      changed = true;
    }
    if (changed) this.lastChangeAt = now;
    return changed;
  }

  moving(now: number): boolean {
    return now - this.lastChangeAt < VIEW_SETTLE_MS;
  }

  /** Forget the view, so the next frame recorded counts as a change. */
  reset(): void {
    this.last.fill(NaN);
  }
}

/** Where this frame's view stands against the bake: whether it must be redone, whether the view is moving, and whether a settle frame is owed. */
export type Fit = { rebuild: boolean; moving: boolean; settling: boolean };

/** How a mode anchors the bake: the camera to bake with, the target's size, and the quads' placement. */
export interface TraceView {
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
  place(main: CompositedTarget, trailing: CompositedTarget, moving: boolean): void;
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
export class PlanarView implements TraceView {
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

  place(main: CompositedTarget, trailing: CompositedTarget, moving: boolean): void {
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
export class PerspectiveView implements TraceView {
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

  place(main: CompositedTarget, trailing: CompositedTarget): void {
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
