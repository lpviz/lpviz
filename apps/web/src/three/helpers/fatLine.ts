import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
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
export function setFatLineResolution(width: number, height: number): void {
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
// bounds are fake) and hidden until its first draw.
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
function replaceLinePositions(geo: LineSegmentsGeometry, positions: Float32Array | number[]): void {
  geo.dispose();
  geo.setPositions(positions);
  delete (geo as unknown as { _maxInstanceCount?: number })._maxInstanceCount;
}

export type FatLineStyle = { color: string; linewidth: number; opacity?: number; renderOrder: number };

// A fat line (screen-space width) that owns its geometry: drawn from segment endpoint triples
// with the material of the view's depth mode, hidden between draws. The line counterpart of
// PointCloud.
export class FatLine {
  readonly object3D: LineSegments2;

  constructor(private readonly style: FatLineStyle) {
    this.object3D = setupLine(new LineSegments2(lineGeometry(), lineDepthMaterial(style.color, style.linewidth, false, style.opacity)), style.renderOrder);
  }

  /** Upload the segments and show them; `color` overrides the style's for an accent. */
  draw(positions: Float32Array | number[], is3D: boolean, color = this.style.color): void {
    replaceLinePositions(this.object3D.geometry, positions);
    this.object3D.material = lineDepthMaterial(color, this.style.linewidth, is3D, this.style.opacity);
    this.object3D.visible = true;
  }

  hide(): void {
    this.object3D.visible = false;
  }

  dispose(): void {
    this.object3D.geometry.dispose();
  }
}
