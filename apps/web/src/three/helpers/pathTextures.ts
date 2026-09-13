import { DataTexture, FloatType, NearestFilter, RGBAFormat } from "three";

// A polyline's points live in a float texture indexed by gl_VertexID, so a path
// costs one RGBA32F texel per point of GPU memory, geometries need no vertex
// attributes at all, and the ribbon and tube renderers share one upload path.
// Rows are TEX_WIDTH texels wide; point i sits at (i & MASK, i >> SHIFT).
const PATH_TEX_WIDTH = 4096;
const PATH_TEX_WIDTH_MASK = PATH_TEX_WIDTH - 1;
const PATH_TEX_WIDTH_SHIFT = 12;

// GLSL helper shared by every path shader: the texel holding point `i`,
// clamped into range so index arithmetic past either end is harmless.
export const PATH_TEXEL_GLSL = /* glsl */ `
ivec2 pathTexel(int i, int count) {
  i = clamp(i, 0, count - 1);
  return ivec2(i & ${PATH_TEX_WIDTH_MASK}, i >> ${PATH_TEX_WIDTH_SHIFT});
}
`;

// bound when a path has no per-point colors, keeping a single program
export const DUMMY_COLOR_TEXTURE = new DataTexture(
  new Uint8Array([255, 255, 255, 255]),
  1,
  1,
  RGBAFormat,
);
DUMMY_COLOR_TEXTURE.needsUpdate = true;

function nearest<T extends DataTexture>(texture: T): T {
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}

// Path/color textures are reused in place when large enough (grow-only):
// solver steps replace paths dozens of times per second, and allocating a
// texture per step churns both the GC and the GL driver.
export class PathTextures {
  path: DataTexture | null = null;
  color: DataTexture | null = null;

  // points: per-point [x, y, z]; colors: optional per-point linear RGBA bytes.
  // Stale texels beyond pointCount are never fetched (indices clamp).
  upload(points: Float32Array, pointCount: number, colors?: Uint8Array | null): void {
    const rows = Math.max(1, Math.ceil(pointCount / PATH_TEX_WIDTH));
    if (!this.path || (this.path.image.height as number) < rows) {
      this.path?.dispose();
      this.path = nearest(
        new DataTexture(
          new Float32Array(PATH_TEX_WIDTH * rows * 4),
          PATH_TEX_WIDTH,
          rows,
          RGBAFormat,
          FloatType,
        ),
      );
    }
    const data = this.path.image.data as Float32Array;
    for (let i = 0; i < pointCount; i++) {
      data[i * 4] = points[i * 3]!;
      data[i * 4 + 1] = points[i * 3 + 1]!;
      data[i * 4 + 2] = points[i * 3 + 2]!;
      data[i * 4 + 3] = 1;
    }
    this.path.needsUpdate = true;

    if (!colors) return;
    if (!this.color || (this.color.image.height as number) < rows) {
      this.color?.dispose();
      this.color = nearest(
        new DataTexture(
          new Uint8Array(PATH_TEX_WIDTH * rows * 4),
          PATH_TEX_WIDTH,
          rows,
          RGBAFormat,
        ),
      );
    }
    (this.color.image.data as Uint8Array).set(colors.subarray(0, pointCount * 4));
    this.color.needsUpdate = true;
  }

  dispose(): void {
    this.path?.dispose();
    this.color?.dispose();
    this.path = null;
    this.color = null;
  }
}
