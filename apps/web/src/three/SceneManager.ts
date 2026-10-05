import { getCurrentMouse, subscribeCurrentMouse } from "@/features/core/currentMouse";
import { getState, type ViewportDirtyFlags } from "@/features/core/store";
import { getViewportRenderSnapshot } from "@/features/viewport/runtime/snapshot";
import { Camera, Scene, WebGLRenderer } from "three";
import type { ImpostorResult, ImpostorStrategy } from "./ImpostorStrategy";
import { RENDER_PASSES, type Layer, type RenderPassName } from "./Layer";
import { LayerHost } from "./LayerHost";
import type { SceneContext } from "./SceneContext";
import { TracePassImpostor } from "./TracePassImpostor";

type Size = { width: number; height: number; dpr: number };

type RenderScenes = Record<RenderPassName, Scene>;

export class SceneManager {
  readonly scenes: RenderScenes = {
    background: new Scene(),
    transparent: new Scene(),
    foreground: new Scene(),
    vertices: new Scene(),
    traceLines: new Scene(),
    trace: new Scene(),
    overlay: new Scene(),
  };
  readonly renderer: WebGLRenderer;
  readonly layerHost = new LayerHost();
  private traceImpostor = new TracePassImpostor(
    () => this.invalidate({ layers: false }),
    () => [this.scenes.transparent, this.scenes.foreground],
  );
  // per-pass render substitutions; only the trace pass has one today
  private impostors: Partial<Record<RenderPassName, ImpostorStrategy>> = {
    traceLines: this.traceImpostor,
  };
  // reused across frames so the render loop allocates no Map per frame; holds
  // each impostor's prepared result between the prepare pass and the draw pass
  private readonly substitutions = new Map<RenderPassName, ImpostorResult>();

  private camera: Camera | null = null;
  private dirty = true;
  private layersDirty: "all" | ViewportDirtyFlags | null = "all";
  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private unsubscribeCurrentMouse: (() => void) | null = null;
  private disposed = false;
  private ticks = new Set<(ctx: SceneContext) => void>();

  private _size: Size = { width: 0, height: 0, dpr: 1 };
  private sizeListeners = new Set<(size: Size) => void>();

  readonly sizeSignal = {
    subscribe: (fn: (size: Size) => void): (() => void) => {
      this.sizeListeners.add(fn);
      return () => {
        this.sizeListeners.delete(fn);
      };
    },
    get: (): Size => this._size,
  };

  private readonly ctx: SceneContext;

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

    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        const height = entry.contentRect.height;
        this.setSize(width, height);
      }
    });
    this.resizeObserver.observe(canvas);

    this.ctx = {
      getSnapshot: getViewportRenderSnapshot,
      getState,
      getCurrentMouse,
    };

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
    this.sizeListeners.forEach((fn) => fn(this._size));
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
      tick(this.ctx);
    }

    if (this.layersDirty) {
      const layersDirty = this.layersDirty;
      this.layersDirty = null;
      this.layerHost.update(this.ctx, layersDirty === "all" ? undefined : layersDirty);
    }

    if (this.camera) {
      this.renderScenes(this.camera);
    }

    if (this.dirty) {
      this.scheduleFrame();
    }
  };

  invalidate(options: { layers?: boolean; viewportDirty?: ViewportDirtyFlags } = {}): void {
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
        this.traceImpostor.markContentDirty();
      }
    }
    this.dirty = true;
    this.scheduleFrame();
  }

  setCamera(cam: Camera): void {
    this.camera = cam;
  }

  addLayer(layer: Layer): void {
    this.layerHost.add(layer);
    if (layer.renderObjects) {
      for (const { object3D, pass } of layer.renderObjects) {
        this.scenes[pass].add(object3D);
      }
    } else {
      this.scenes[layer.renderPass ?? "foreground"].add(layer.object3D);
    }
    this.invalidate();
  }

  removeLayer(layer: Layer): void {
    this.layerHost.remove(layer);
    if (layer.renderObjects) {
      for (const { object3D, pass } of layer.renderObjects) {
        this.scenes[pass].remove(object3D);
      }
    } else {
      this.scenes[layer.renderPass ?? "foreground"].remove(layer.object3D);
    }
    this.invalidate();
  }

  addTick(fn: (ctx: SceneContext) => void): void {
    this.ticks.add(fn);
  }

  removeTick(fn: (ctx: SceneContext) => void): void {
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

    this.layerHost.dispose();
    this.traceImpostor.dispose();
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
    // Prepare all impostors first: their offscreen baking (cache rebuild, 3D
    // depth pre-pass) must run before any canvas pass renders, or a mid-loop
    // render-target switch drops the composited result.
    const substitutions = this.substitutions;
    substitutions.clear();
    for (const pass of RENDER_PASSES) {
      const impostor = this.impostors[pass];
      if (impostor) {
        substitutions.set(pass, impostor.prepare(this.renderer, camera, this.scenes[pass]));
      }
    }
    for (const pass of RENDER_PASSES) {
      if (substitutions.has(pass)) {
        const result = substitutions.get(pass);
        if (result === "skip") continue;
        if (result) {
          this.renderer.render(result.scene, result.camera);
          continue;
        }
      }
      const scene = this.scenes[pass];
      if (scene.children.length === 0 || scene.children.every(isHidden)) {
        continue;
      }
      this.renderer.render(scene, camera);
    }
    this.renderer.autoClear = true;
  }
}

function isHidden(object: { visible: boolean }): boolean {
  return !object.visible;
}
