import { BufferGeometry } from "three";
import { applyHugeBounds } from "./sharedLineMaterials";

export function makePointsGeo(): BufferGeometry {
  const geo = new BufferGeometry();
  applyHugeBounds(geo);
  return geo;
}
