// Render-order buckets within the explicit scene passes (see RENDER_PASSES): they only break ties
// inside a pass, the passes themselves render in order. Grouped here by the pass they sort.
export const RENDER_ORDER = {
  // background
  grid: 0,
  // transparent
  polytopeFill: 2,
  // foreground
  polyEdges: 3,
  objective: 4,
  constraintLines: 6,
  // vertices
  polytopeVertices: 12,
  // traceLines
  traceLine: 5,
  // trace
  tracePoints: 14,
  ellipsoid: 18,
  iterateLine: 20,
  iteratePoints: 22,
  iterateRestartPoints: 23,
  iterateHighlight: 26,
  // overlay
  iterateStar: 24,
  solverStart: 25,
} as const;
