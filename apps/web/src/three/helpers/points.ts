import { BufferGeometry, Points, PointsMaterial, type Texture } from "three";
import { applyHugeBounds } from "./hugeBounds";

// Every point sprite in the app: a fixed screen-size, depth-ignoring sprite
// whose shape is an alpha map (see sharedTextures.ts).
export function pointsMaterial(texture: Texture, size: number, color: string, opacity = 1, vertexColors = false): PointsMaterial {
  return new PointsMaterial({ color, size, sizeAttenuation: false, transparent: opacity < 1, opacity, depthTest: false, depthWrite: false, alphaMap: texture, alphaTest: 0.2, vertexColors });
}

// A Points object over an empty geometry with fake huge bounds (so the
// renderer neither computes them nor culls it), starting in state `visible`.
export function makePoints(material: PointsMaterial, renderOrder: number, visible: boolean): Points {
  const geo = new BufferGeometry();
  applyHugeBounds(geo);
  const points = new Points(geo, material);
  points.renderOrder = renderOrder;
  points.frustumCulled = false;
  points.visible = visible;
  return points;
}
