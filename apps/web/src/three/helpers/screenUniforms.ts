import { Vector2 } from "three";

// The two uniforms the stroke shaders share by reference, so a frame sets each once.
//
// `resolution` is the CSS size screen-space stroke widths are computed against: the canvas's, set
// on resize, and a bake target's own while the trace bakes into one. The ribbons read it from
// here; the fat lines (LineSegments2) take theirs from the renderer's viewport on every draw.
//
// `cacheEncode` is set while a trace bakes. The trace cache composites its targets onto the canvas
// as a passthrough, so what a trace material writes into a target has to be exactly what it would
// write to the canvas. three compiles linearToOutputTexel to the identity for a render target, so
// while a bake runs this flag has the trace materials (the ribbons, the point sprites) sRGB-encode
// their output themselves; sRGBTransferOETF is exactly what linearToOutputTexel aliases for the
// canvas.
export const resolution = new Vector2(1, 1);
export const cacheEncode = { value: 0 };

/** The fragment's final colour as the canvas wants it, encoded by hand while baking (see cacheEncode). */
export const cacheEncodeGlsl = (color: string): string => `(cacheEncode > 0.5 ? sRGBTransferOETF(${color}) : linearToOutputTexel(${color}))`;

export function setCanvasResolution(width: number, height: number): void {
  resolution.set(width, height);
}

/**
 * Run `render` with the trace baking into a render target: the materials encode for it, and the
 * stroke widths are computed against `size` when the target is not the canvas's size. Both are
 * restored afterwards, so the direct passes that follow see exactly what they had.
 */
export function bakeTrace(render: () => void, size?: { width: number; height: number }): void {
  const { x, y } = resolution;
  if (size) resolution.set(size.width, size.height);
  cacheEncode.value = 1;
  render();
  cacheEncode.value = 0;
  resolution.set(x, y);
}
