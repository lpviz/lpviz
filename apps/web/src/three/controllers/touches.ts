import type { PointXY } from "@lpviz/math/types";

/** The midpoint and the distance of the first two touches, in the order they landed. */
export function touchPair(touches: ReadonlyMap<number, PointXY>): { center: PointXY; distance: number } {
  const [a, b] = touches.values();
  if (!a || !b) return { center: a ?? { x: 0, y: 0 }, distance: 0 };
  return { center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.hypot(b.x - a.x, b.y - a.y) };
}
