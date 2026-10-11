// The scene's look, named for what it styles: colours, stroke widths and sprite sizes (CSS pixels).
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

export const STROKE = {
  polytopeEdge: 2,
  objective: 3,
  constraintHighlight: 2,
  iteratePath: 3,
  trace: 2,
  ellipsoidActive: 2.5,
  ellipsoidTrail: 1.5,
  /** the localizing polyhedron: thinner and fainter than the ellipse it accompanies, a boundary that does not compete with the path */
  localizingPolygon: 1.25,
} as const;

export const SPRITE = {
  polytopeVertex: 10,
  iterate: 8,
  tracePoint: 6,
  solverStart: 15,
  iterateStar: 27,
} as const;
