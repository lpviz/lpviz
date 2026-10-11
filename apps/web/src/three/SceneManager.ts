import { getState, type State } from "@/features/core/store";
import { singleFrame } from "@/features/core/timers";
import type { ViewportDirtyFlags, Repaint } from "@/features/viewport/dirtyFlags";
import { getViewportRenderSnapshot } from "@/features/viewport/runtime/snapshot";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import type { Camera } from "three";
import { Scene, WebGLRenderer } from "three";
import { setFatLineResolution } from "./helpers/fatLine";
import { drawsNothing, type TraceFrame, type TraceImpostor, type TracePassImpostor } from "./helpers/traceComposite";
import { RENDER_PASSES, type Layer, type RenderPassName } from "./Layer";
import { Trace3DCompositor } from "./Trace3DCompositor";
import { TraceCache } from "./TraceCache";

type Size = { width: number; height: number; dpr: number };

// The device pixel ratio the canvas renders at: never below 1, and capped at a phone's 3 so an
// outlier display cannot multiply the fill cost without bound. Below the cap the canvas is
// pixel-aligned with the screen; above it the browser would stretch the buffer.
const MAX_DPR = 3;
const clampDpr = () => Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio));

// The demand-driven render loop: a frame per invalidation, in which the ticks run, the layers
// named dirty rebuild (every layer when all are), and the passes render in order, the trace pass
// through an impostor when one applies.
export class SceneManager {
  readonly scenes = Object.fromEntries(RENDER_PASSES.map((pass) => [pass, new Scene()])) as Record<RenderPassName, Scene>;
  readonly renderer: WebGLRenderer;
  private layers: Layer[] = [];
  // The traceLines pass renders through the first impostor that applies: in 2D a world-anchored
  // accumulation cache (so neither camera motion nor a trace append re-renders baked chunks); while
  // the 3D view is in motion a single-sample offscreen composite instead of the MSAA canvas.
  private readonly traceCache = new TraceCache(() => this.invalidate("frame"));
  private readonly traceImpostors: readonly TraceImpostor[] = [this.traceCache, new Trace3DCompositor(() => this.invalidate("frame"))];
  // the scenes whose geometry occludes the trace
  private readonly occluders = [this.scenes.transparent, this.scenes.foreground];

  private camera: Camera | null = null;
  // a frame is wanted; a tick or a layer update can want another mid-frame
  private frameRequested = true;
  private layersDirty: "all" | ViewportDirtyFlags | null = "all";
  private frame = singleFrame();
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;
  private ticks = new Set<() => void>();

  private size: Size = { width: 0, height: 0, dpr: 1 };

  constructor(canvas: HTMLCanvasElement) {
    const dpr = clampDpr();

    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(dpr);

    this.size = { width: canvas.clientWidth, height: canvas.clientHeight, dpr };
    this.renderer.setSize(this.size.width, this.size.height, false);
    // screen-space line widths need the CSS resolution before the first render
    setFatLineResolution(this.size.width, this.size.height);

    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        const height = entry.contentRect.height;
        this.setSize(width, height);
      }
    });
    this.resizeObserver.observe(canvas);
  }

  private setSize(width: number, height: number): void {
    const dpr = clampDpr();
    if (this.size.width === width && this.size.height === height && this.size.dpr === dpr) return;
    this.size = { width, height, dpr };
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    setFatLineResolution(width, height);
    this.invalidate();
  }

  private scheduleFrame(): void {
    if (!this.disposed) this.frame.request(this.loop);
  }

  private loop = (): void => {
    if (this.disposed || !this.frameRequested) return;
    this.frameRequested = false;

    for (const tick of this.ticks) {
      tick();
    }

    // the frame's inputs, read once after the ticks have moved the view
    const state = getState();
    const snapshot = getViewportRenderSnapshot();
    if (this.layersDirty) {
      const only = this.layersDirty === "all" ? null : this.layersDirty;
      this.layersDirty = null;
      for (const layer of this.layers) {
        if (only && layer.invalidationKeys.every((key) => !only[key])) continue;
        layer.update(state, snapshot);
      }
    }

    if (this.camera) {
      this.renderScenes(this.camera, state, snapshot);
    }

    if (this.frameRequested) {
      this.scheduleFrame();
    }
  };

  // Asks for a frame; the first one starts the demand-driven loop.
  invalidate(repaint: Repaint = "all"): void {
    if (repaint === "all") {
      this.layersDirty = "all";
      // a whole rebuild (e.g. a layer-content change) must drop the bake
      this.traceCache.markContentDirty();
    } else if (repaint !== "frame" && this.layersDirty !== "all") {
      // trace appends/evictions are detected by TraceCache itself via the
      // chunk sequence numbers, so trace/iterate dirt needs no cache flush
      this.layersDirty = { ...this.layersDirty, ...repaint };
    }
    this.frameRequested = true;
    this.scheduleFrame();
  }

  setCamera(cam: Camera): void {
    this.camera = cam;
  }

  addLayer(layer: Layer): void {
    this.layers.push(layer);
    for (const { object3D, pass } of layer.placements()) {
      this.scenes[pass].add(object3D);
    }
    this.invalidate();
  }

  addTick(fn: () => void): void {
    this.ticks.add(fn);
  }

  removeTick(fn: () => void): void {
    this.ticks.delete(fn);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    this.frame.cancel();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    for (const layer of this.layers) {
      layer.dispose();
    }
    this.layers = [];
    for (const impostor of this.traceImpostors) impostor.dispose();
    for (const scene of Object.values(this.scenes)) {
      scene.clear();
    }

    this.renderer.dispose();
  }

  private renderScenes(camera: Camera, state: State, snapshot: ViewportRenderSnapshot): void {
    this.renderer.clear();
    this.renderer.autoClear = false;
    // The trace impostors bake offscreen (cache rebuild, 3D depth pre-pass) before any canvas pass
    // renders, or a mid-loop render-target switch would drop the composited result.
    const frame: TraceFrame = { renderer: this.renderer, camera, state, snapshot, traceLines: this.scenes.traceLines, occluders: this.occluders };
    let impostor: TracePassImpostor | null = null;
    for (const candidate of this.traceImpostors) {
      impostor = candidate.prepare(frame);
      if (impostor) break;
    }
    for (const pass of RENDER_PASSES) {
      const substitute = pass === "traceLines" ? impostor : null;
      const scene = substitute?.scene ?? this.scenes[pass];
      if (drawsNothing(scene)) continue;
      this.renderer.render(scene, substitute?.camera ?? camera);
    }
    this.renderer.autoClear = true;
  }
}
