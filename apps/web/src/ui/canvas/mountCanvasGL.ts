import { el } from "@/ui/dom";
import { createViewportRuntime } from "@/features/viewport/runtime";
import type { ViewportBridge } from "@/features/viewport/types";
import { SceneManager } from "@/three/SceneManager";
import { CameraController } from "@/three/controllers/CameraController";
import { attachOrbit3D } from "@/three/controllers/orbit3D";
import { attachPanZoom2D } from "@/three/controllers/panZoom2D";
import { ConstraintHighlightLayer } from "@/three/layers/ConstraintHighlightLayer";
import { EllipsoidLayer } from "@/three/layers/EllipsoidLayer";
import { GridLayer } from "@/three/layers/GridLayer";
import { IterateLineLayer } from "@/three/layers/IterateLineLayer";
import { createIterateHighlightLayer, createIteratePointsLayer, createIterateRestartPointsLayer, createIterateStarLayer } from "@/three/layers/IterateSpritesLayer";
import { ObjectiveLayer } from "@/three/layers/ObjectiveLayer";
import { PolytopeBaseLayer } from "@/three/layers/PolytopeBaseLayer";
import { PolytopeRubberBandLayer } from "@/three/layers/PolytopeRubberBandLayer";
import { PolytopeVerticesLayer } from "@/three/layers/PolytopeVerticesLayer";
import { SolverStartLayer } from "@/three/layers/SolverStartLayer";
import { TraceLayer } from "@/three/layers/TraceLayer";

export function mountCanvasGL(parent: HTMLElement) {
  const canvas = el("canvas", { className: "canvas-stage__gl-canvas", attrs: { tabindex: "0" } });
  parent.append(canvas);
  const mgr = new SceneManager(canvas);
  const bridge: ViewportBridge = {
    getCanvasElement: () => canvas,
    getCanvasRect: () => canvas.getBoundingClientRect(),
    invalidate: (repaint) => mgr.invalidate(repaint),
    addTick: (tick) => {
      mgr.addTick(tick);
      return () => mgr.removeTick(tick);
    },
  };
  // the runtime's tick (the 2D/3D transition's frame) registers before the camera's, so a frame it
  // publishes is posed the same frame
  const viewportApi = createViewportRuntime({ viewportBridge: bridge });
  const cameraCtl = new CameraController(mgr);
  // the 2D listeners register before the 3D ones on the same targets
  const detachPanZoom2D = attachPanZoom2D(canvas);
  const detachOrbit3D = attachOrbit3D(mgr, cameraCtl.perspective, cameraCtl.perspectiveTarget);
  const layers = [
    new GridLayer(),
    new PolytopeBaseLayer(),
    new PolytopeRubberBandLayer(),
    new ObjectiveLayer(),
    new ConstraintHighlightLayer(),
    new PolytopeVerticesLayer(),
    new TraceLayer(),
    new EllipsoidLayer(),
    new IterateLineLayer(),
    createIteratePointsLayer(),
    createIterateRestartPointsLayer(),
    createIterateHighlightLayer(),
    createIterateStarLayer(),
    new SolverStartLayer(),
  ];
  for (const layer of layers) mgr.addLayer(layer);
  mgr.precompile(cameraCtl.perspective);
  return {
    viewportApi,
    destroy: () => {
      viewportApi.destroy();
      detachOrbit3D();
      detachPanZoom2D();
      cameraCtl.dispose();
      mgr.dispose();
      canvas.remove();
    },
  };
}
