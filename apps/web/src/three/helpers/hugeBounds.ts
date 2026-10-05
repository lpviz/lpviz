import { Box3, type BufferGeometry, Sphere, Vector3 } from "three";

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
