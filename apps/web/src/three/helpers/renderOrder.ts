/**
 * Render-order buckets within the explicit scene passes.
 *
 * The viewport renders multiple scenes in this order:
 *   background -> transparent(fill) -> foreground -> vertices -> traceLines -> trace -> overlay
 *
 * These values only break ties inside a pass. Cross-pass ordering is handled
 * by SceneManager.
 */

export const RENDER_ORDER = {
  grid: 0,
  axis: 1,

  polytopeFill: 2,

  polyEdges: 3,
  objective: 4,
  constraintLines: 6,

  polytopeVertices: 12,

  traceLine: 5,

  tracePoints: 14,
  ellipsoid: 18,
  iterateLine: 20,
  iteratePoints: 22,
  iterateRestartPoints: 23,
  iterateHighlight: 26,

  iterateStar: 24,
  solverStart: 25,
} as const;
