export interface PointXY {
  x: number;
  y: number;
}

export interface PointXYZ {
  x: number;
  y: number;
  z: number;
}

type Vec2 = [number, number];
type Vec3 = [number, number, number];
export type VecM = Float64Array;
export type VecN = Float64Array;
export type VecNs = Float64Array[];
export type Vec2N = Float64Array;
export type Vec2Ns = Float64Array[];

export type VectorM = VecM;
export type VectorN = VecN;

export type Vertices = Vec2[];
export type Line = Vec3;
export type Lines = Line[];
export type LineND = number[];
export type LinesND = LineND[];
