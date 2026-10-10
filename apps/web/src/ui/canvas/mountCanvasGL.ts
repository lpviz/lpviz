import type { ViewportBridge } from "@/features/viewport/types";
import { SceneManager } from "@/three/SceneManager";
import { CameraController } from "@/three/controllers/CameraController";
import { attachOrbit3D } from "@/three/controllers/orbit3D";
import { attachPanZoom2D } from "@/three/controllers/panZoom2D";
import { TransitionController } from "@/three/controllers/TransitionController";
import { ConstraintHighlightLayer } from "@/three/layers/ConstraintHighlightLayer";
import { EllipsoidLayer } from "@/three/layers/EllipsoidLayer";
import { GridLayer } from "@/three/layers/GridLayer";
import { IterateLineLayer } from "@/three/layers/IterateLineLayer";
import { createIterateHighlightLayer, createIterateStarLayer } from "@/three/layers/IterateMarkerLayer";
import { IteratePointsLayer } from "@/three/layers/IteratePointsLayer";
import { IterateRestartPointsLayer } from "@/three/layers/IterateRestartPointsLayer";
import { ObjectiveLayer } from "@/three/layers/ObjectiveLayer";
import { PolytopeBaseLayer } from "@/three/layers/PolytopeBaseLayer";
import { PolytopeRubberBandLayer } from "@/three/layers/PolytopeRubberBandLayer";
import { PolytopeVerticesLayer } from "@/three/layers/PolytopeVerticesLayer";
import { SolverStartLayer } from "@/three/layers/SolverStartLayer";
import { TraceLineLayer } from "@/three/layers/TraceLineLayer";
import { TracePointsLayer } from "@/three/layers/TracePointsLayer";

export function mountCanvasGL(parent: HTMLElement, onBridgeReady: (bridge: ViewportBridge) => void, onBridgeDispose: () => void) {
  const canvas = document.createElement("canvas");
  canvas.className = "canvas-stage__gl-canvas";
  canvas.tabIndex = 0;
  parent.append(canvas);
  const mgr = new SceneManager(canvas);
  // the transition's tick runs before the camera's, so a frame it publishes is posed the same frame
  const transitionCtl = new TransitionController(mgr);
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
    new TraceLineLayer(),
    new TracePointsLayer(),
    new EllipsoidLayer(),
    new IterateLineLayer(),
    new IteratePointsLayer(),
    new IterateRestartPointsLayer(),
    createIterateHighlightLayer(),
    createIterateStarLayer(),
    new SolverStartLayer(),
  ];
  for (const layer of layers) mgr.addLayer(layer);
  onBridgeReady({
    getCanvasElement: () => canvas,
    getCanvasRect: () => canvas.getBoundingClientRect(),
    invalidate: (options) => mgr.invalidate(options),
  });
  return {
    destroy: () => {
      detachOrbit3D();
      detachPanZoom2D();
      cameraCtl.dispose();
      transitionCtl.dispose();
      mgr.dispose();
      onBridgeDispose();
      canvas.remove();
    },
  };
}
