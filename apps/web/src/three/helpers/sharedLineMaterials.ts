import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { applyHugeBounds } from "./hugeBounds";
import { setPathRibbonResolution } from "./pathRibbon";

const materialCache = new Map<string, LineMaterial>();

// The depth-on-in-3D line material every polytope/objective/constraint layer
// wants: 2D paints in draw order (no depth), 3D depth-tests so the floor
// occludes correctly. One instance per distinct parameter set, shared by
// every object that asks for it.
export function lineDepthMaterial(color: string, linewidth: number, is3D: boolean, opacity = 1): LineMaterial {
  const key = `${color}|${linewidth}|${is3D}|${opacity}`;
  let mat = materialCache.get(key);
  if (!mat) {
    mat = new LineMaterial({ color, linewidth, depthTest: is3D, depthWrite: is3D, transparent: opacity < 1, opacity });
    materialCache.set(key, mat);
  }
  return mat;
}

let lastWidth = 0;
let lastHeight = 0;

// The CSS resolution every screen-space line width is computed against; set on resize.
export function setSharedLineResolution(width: number, height: number): void {
  if (width === lastWidth && height === lastHeight) return;
  lastWidth = width;
  lastHeight = height;
  materialCache.forEach((mat) => mat.resolution.set(width, height));
  setPathRibbonResolution(width, height);
}

export function lineGeometry(): LineSegmentsGeometry {
  const geo = new LineSegmentsGeometry();
  applyHugeBounds(geo);
  return geo;
}

// Every fat-line object in the app: never frustum-culled (its geometry's
// bounds are fake) and hidden until its first rebuild.
export function setupLine<T extends LineSegments2>(line: T, renderOrder: number): T {
  line.renderOrder = renderOrder;
  line.frustumCulled = false;
  line.visible = false;
  return line;
}

// setPositions() wraps its input in a brand-new interleaved buffer on every
// call, and the renderer only deletes GL buffers on geometry dispose — a
// replaced attribute's buffer is otherwise orphaned until the JS wrapper is
// garbage collected. Dispose first; the new buffers upload on the next render.
export function replaceLinePositions(geo: LineSegmentsGeometry, positions: Float32Array | number[]): void {
  geo.dispose();
  geo.setPositions(positions);
  delete (geo as unknown as { _maxInstanceCount?: number })._maxInstanceCount;
}
