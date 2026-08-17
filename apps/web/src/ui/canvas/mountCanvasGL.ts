import type { ViewportBridge } from "@/features/viewport/types";
import type { Layer } from "@/three/Layer";
import { SceneManager } from "@/three/SceneManager";
import { CameraController } from "@/three/controllers/CameraController";
import { ControlsController } from "@/three/controllers/ControlsController";
import { SharedMaterialsController } from "@/three/controllers/SharedMaterialsController";
import { TransitionController } from "@/three/controllers/TransitionController";
import { ConstraintHighlightLayer } from "@/three/layers/ConstraintHighlightLayer";
import { EllipsoidLayer } from "@/three/layers/EllipsoidLayer";
import { GridLayer } from "@/three/layers/GridLayer";
import { IterateHighlightLayer } from "@/three/layers/IterateHighlightLayer";
import { IterateLineLayer } from "@/three/layers/IterateLineLayer";
import { IteratePointsLayer } from "@/three/layers/IteratePointsLayer";
import { IterateRestartPointsLayer } from "@/three/layers/IterateRestartPointsLayer";
import { IterateStarLayer } from "@/three/layers/IterateStarLayer";
import { ObjectiveLayer } from "@/three/layers/ObjectiveLayer";
import { PolytopeBaseLayer } from "@/three/layers/PolytopeBaseLayer";
import { PolytopeRubberBandLayer } from "@/three/layers/PolytopeRubberBandLayer";
import { PolytopeVerticesLayer } from "@/three/layers/PolytopeVerticesLayer";
import { SolverStartLayer } from "@/three/layers/SolverStartLayer";
import { TraceLineLayer } from "@/three/layers/TraceLineLayer";
import { TracePointsLayer } from "@/three/layers/TracePointsLayer";

export function mountCanvasGL(
  parent: HTMLElement,
  onBridgeReady: (bridge: ViewportBridge) => void,
  onBridgeDispose?: () => void,
) {
  const canvas = document.createElement("canvas");
  canvas.className = "canvas-stage__gl-canvas";
  canvas.tabIndex = 0;
  parent.append(canvas);
  const mgr = new SceneManager(canvas, { dpr: [1, 2] });
  const transitionCtl = new TransitionController(mgr);
  mgr.addTick(() => transitionCtl.tick());
  const cameraCtl = new CameraController(mgr);
  const controlsCtl = new ControlsController(mgr);
  const materialsCtl = new SharedMaterialsController(mgr);
  const layers: Layer[] = [
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
    new IterateHighlightLayer(),
    new IterateStarLayer(),
    new SolverStartLayer(),
  ];
  for (const l of layers) mgr.addLayer(l);
  onBridgeReady({
    getCanvasElement: () => canvas,
    getCanvasRect: () => canvas.getBoundingClientRect(),
    invalidate: (options) => mgr.invalidate(options),
  });
  mgr.start();
  return {
    canvas,
    destroy: () => {
      for (const l of layers) {
        mgr.removeLayer(l);
        l.dispose();
      }
      controlsCtl.dispose();
      cameraCtl.dispose();
      transitionCtl.dispose();
      materialsCtl.dispose();
      mgr.dispose();
      onBridgeDispose?.();
      canvas.remove();
    },
  };
}
