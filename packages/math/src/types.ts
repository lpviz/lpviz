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

// One constraint a·x ≤ b of the problem as [a1, ..., an, b]: [A, B, C] for two variables, where
// its boundary is the line Ax + By = C.
export type Constraint = [number, number, number, ...number[]];
