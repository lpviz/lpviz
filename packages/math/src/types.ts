// Canvas and screen coordinates, and camera angles. Points of the problem itself are `Vec`.
export interface PointXY {
  x: number;
  y: number;
}

export interface PointXYZ {
  x: number;
  y: number;
  z: number;
}

// A point or direction in problem space: one coordinate per decision variable, so its length is the
// problem's dimension. Code written for two variables reads v[0] and v[1].
export type Vec = [number, number, ...number[]];
export type VecN = Float64Array;
export type VecNs = Float64Array[];
export type Vec2N = Float64Array;
export type Vec2Ns = Float64Array[];

export type Vertices = Vec[];
// A half-space a·x ≤ b as [a1, ..., an, b]: [A, B, C] for two variables.
export type Line = [number, number, number, ...number[]];
export type Lines = Line[];
