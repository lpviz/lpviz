// The scene's colors, named for what they color.
export const PALETTE = {
  grid: "#e0e0e0",
  axis: "#707070",
  polytopeFill: "#e6e6e6",
  polytopeOutline: "#000000",
  /** the drawing's accent: its vertices, a highlighted edge or constraint, a nonconvex fill, an unbounded objective */
  accent: "#ff0000",
  objective: "#008000",
  /** the hovered iterate and the optimum star */
  iterateMarker: "#008000",
  iterate: "#800080",
  trace: "#ffa500",
  ellipsoid: "#377eb8",
  solverStart: "#8a8a8a",
} as const;
