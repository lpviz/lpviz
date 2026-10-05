import { Box3, type BufferGeometry, Sphere, Vector3 } from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { setPathRibbonResolution } from "./pathRibbon";

type LineMaterialKey = {
  color: string | number;
  linewidth: number;
  depthTest: boolean;
  depthWrite: boolean;
  opacity: number;
};

const materialCache = new Map<string, LineMaterial>();

function makeKey(k: LineMaterialKey): string {
  return `${k.color}|${k.linewidth}|${k.depthTest}|${k.depthWrite}|${k.opacity}`;
}

// The depth-on-in-3D line material every polytope/objective/constraint layer
// wants: 2D paints in draw order (no depth), 3D depth-tests so the floor
// occludes correctly. Wraps the shared cache.
export function lineDepthMaterial(color: string | number, linewidth: number, is3D: boolean, opacity = 1): LineMaterial {
  return getSharedLineMaterial({
    color,
    linewidth,
    depthTest: is3D,
    depthWrite: is3D,
    opacity,
  });
}

export function getSharedLineMaterial(opts: LineMaterialKey): LineMaterial {
  const key = makeKey(opts);
  let mat = materialCache.get(key);
  if (!mat) {
    mat = new LineMaterial({
      color: opts.color,
      linewidth: opts.linewidth,
      depthTest: opts.depthTest,
      depthWrite: opts.depthWrite,
      transparent: opts.opacity < 1,
      opacity: opts.opacity,
    });
    materialCache.set(key, mat);
  }
  return mat;
}

let _lastW = 0;
let _lastH = 0;

export function tickSharedLineMaterialResolutions(w: number, h: number): void {
  if (w === _lastW && h === _lastH) return;
  _lastW = w;
  _lastH = h;
  materialCache.forEach((mat) => mat.resolution.set(w, h));
  setPathRibbonResolution(w, h);
}

// ─── Bounding volume helpers ──────────────────────────────────────────────────
// Pre-set a huge bounding box/sphere and no-op the compute methods so
// setPositions() (which calls them internally) does no unnecessary work.

const HUGE = 1e10;
const HUGE_BOX = new Box3(new Vector3(-HUGE, -HUGE, -HUGE), new Vector3(HUGE, HUGE, HUGE));
const HUGE_SPHERE = new Sphere(new Vector3(0, 0, 0), HUGE);

export function applyHugeBounds(geo: BufferGeometry): void {
  geo.boundingBox = HUGE_BOX.clone();
  geo.boundingSphere = HUGE_SPHERE.clone();
  geo.computeBoundingBox = () => {};
  geo.computeBoundingSphere = () => {};
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
