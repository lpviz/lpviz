import { subscribeCurrentMouse } from "@/features/core/currentMouse";
import { getState, type ViewportDirtyFlags } from "@/features/core/store";
import { Camera, Scene, WebGLRenderer } from "three";
import { tickSharedLineMaterialResolutions } from "./helpers/sharedLineMaterials";
import { RENDER_PASSES, type Layer, type RenderPassName } from "./Layer";
import { Trace3DCompositor } from "./Trace3DCompositor";
import { TraceCache } from "./TraceCache";

type Size = { width: number; height: number; dpr: number };

export class SceneManager {
  readonly scenes = Object.fromEntries(RENDER_PASSES.map((pass) => [pass, new Scene()])) as Record<RenderPassName, Scene>;
  readonly renderer: WebGLRenderer;
  private layers: Layer[] = [];
  // The trace-lines pass renders through an impostor when one applies: in 2D
  // a world-anchored accumulation cache (so neither camera motion nor a trace
  // append re-renders baked chunks); while the 3D view is in motion a
  // single-sample offscreen composite instead of the MSAA canvas.
  private traceCache = new TraceCache(() => this.invalidate({ layers: false }));
  private trace3D = new Trace3DCompositor(() => this.invalidate({ layers: false }));

  private camera: Camera | null = null;
  private dirty = true;
  private layersDirty: "all" | ViewportDirtyFlags | null = "all";
  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private unsubscribeCurrentMouse: (() => void) | null = null;
  private disposed = false;
  private ticks = new Set<() => void>();

  private _size: Size = { width: 0, height: 0, dpr: 1 };

  constructor(canvas: HTMLCanvasElement, options: { dpr: [number, number] }) {
    const [minDpr, maxDpr] = options.dpr;
    const dpr = Math.min(maxDpr, Math.max(minDpr, window.devicePixelRatio));

    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(dpr);

    this._size = {
      width: canvas.clientWidth,
      height: canvas.clientHeight,
      dpr,
    };
    this.renderer.setSize(this._size.width, this._size.height, false);
    // screen-space line widths need the CSS resolution before the first render
    tickSharedLineMaterialResolutions(this._size.width, this._size.height);

    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        const height = entry.contentRect.height;
        this.setSize(width, height);
      }
    });
    this.resizeObserver.observe(canvas);

    this.unsubscribeCurrentMouse = subscribeCurrentMouse(() => {
      const state = getState();
      if (state.completionMode !== "draft" || state.vertices.length === 0) {
        return;
      }
      this.invalidate({ viewportDirty: { polytope: true } });
    });
  }

  private setSize(width: number, height: number): void {
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio));
    if (this._size.width === width && this._size.height === height && this._size.dpr === dpr) {
      return;
    }
    this._size = { width, height, dpr };
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    tickSharedLineMaterialResolutions(width, height);
    this.invalidate();
  }

  start(): void {
    this.scheduleFrame();
  }

  private scheduleFrame(): void {
    if (this.disposed || this.rafId !== null) {
      return;
    }
    this.rafId = requestAnimationFrame(this.loop);
  }

  private loop = (): void => {
    if (this.disposed) {
      return;
    }
    this.rafId = null;

    if (!this.dirty) {
      return;
    }
    this.dirty = false;

    for (const tick of this.ticks) {
      tick();
    }

    if (this.layersDirty) {
      const dirty = this.layersDirty === "all" ? null : this.layersDirty;
      this.layersDirty = null;
      for (const layer of this.layers) {
        if (dirty && layer.invalidationKeys.every((key) => !dirty[key])) {
          continue;
        }
        layer.update();
      }
    }

    if (this.camera) {
      this.renderScenes(this.camera);
    }

    if (this.dirty) {
      this.scheduleFrame();
    }
  };

  invalidate(options: { layers?: boolean; viewportDirty?: ViewportDirtyFlags | undefined } = {}): void {
    if (options.layers ?? true) {
      if (options.viewportDirty && Object.keys(options.viewportDirty).length) {
        if (this.layersDirty !== "all") {
          this.layersDirty = {
            ...(this.layersDirty ?? {}),
            ...options.viewportDirty,
          };
        }
        // trace appends/evictions are detected by TraceCache itself via the
        // chunk sequence numbers, so trace/iterate dirt needs no cache flush
      } else {
        this.layersDirty = "all";
        // a flagless invalidate (e.g. layer-content change) must drop the bake
        this.traceCache.markContentDirty();
      }
    }
    this.dirty = true;
    this.scheduleFrame();
  }

  setCamera(cam: Camera): void {
    this.camera = cam;
  }

  addLayer(layer: Layer): void {
    this.layers.push(layer);
    if (layer.renderObjects) {
      for (const { object3D, pass } of layer.renderObjects) {
        this.scenes[pass].add(object3D);
      }
    } else {
      this.scenes[layer.renderPass ?? "foreground"].add(layer.object3D);
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

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.unsubscribeCurrentMouse?.();
    this.unsubscribeCurrentMouse = null;

    for (const layer of this.layers) {
      layer.dispose();
    }
    this.layers = [];
    this.traceCache.dispose();
    this.trace3D.dispose();
    for (const scene of Object.values(this.scenes)) {
      for (const child of [...scene.children]) {
        scene.remove(child);
      }
    }

    this.renderer.dispose();
  }

  private renderScenes(camera: Camera): void {
    this.renderer.clear();
    this.renderer.autoClear = false;
    // The trace impostors bake offscreen (cache rebuild, 3D depth pre-pass)
    // before any canvas pass renders, or a mid-loop render-target switch would
    // drop the composited result. The cache wins when it applies; the 3D
    // compositor is consulted only for a pass that has something to draw.
    const traceLines = this.scenes.traceLines;
    const cached = this.traceCache.prepare(this.renderer, traceLines);
    const composited = cached || nothingVisible(traceLines) ? null : this.trace3D.prepare(this.renderer, camera, traceLines, [this.scenes.transparent, this.scenes.foreground]);
    for (const pass of RENDER_PASSES) {
      let scene = this.scenes[pass];
      let passCamera = camera;
      if (pass === "traceLines" && cached) {
        scene = cached;
      } else if (pass === "traceLines" && composited) {
        scene = composited;
        passCamera = this.trace3D.camera;
      }
      if (nothingVisible(scene)) {
        continue;
      }
      this.renderer.render(scene, passCamera);
    }
    this.renderer.autoClear = true;
  }
}

function nothingVisible(scene: Scene): boolean {
  return scene.children.every((child) => !child.visible);
}
