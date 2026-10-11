// The trace impostors bake the trace into render targets and composite the result onto the canvas
// as a passthrough, so what a trace material writes into a target has to be exactly what it would
// write to the canvas. three compiles linearToOutputTexel to the identity for a render target, so
// while a bake runs this flag has the trace materials (the ribbons, the point sprites) sRGB-encode
// their output themselves; sRGBTransferOETF is exactly what linearToOutputTexel aliases for the
// canvas. Shared by reference across every such material as its `cacheEncode` uniform.
export const sharedCacheEncode = { value: 0 };

/** The fragment's final colour as the canvas wants it, encoded by hand while baking (see sharedCacheEncode). */
export const cacheEncodeGlsl = (color: string): string => `(cacheEncode > 0.5 ? sRGBTransferOETF(${color}) : linearToOutputTexel(${color}))`;

/** Run `render` with the trace materials encoding for a render target. */
export function withCacheEncode(render: () => void): void {
  sharedCacheEncode.value = 1;
  render();
  sharedCacheEncode.value = 0;
}
