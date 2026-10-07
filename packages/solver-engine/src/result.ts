// The one shape every engine returns: the iterates it visited plus the log it
// prints. The app flattens the iterates for the viewport and renders the log.

/** The columns of one iterate's log row. `convergence` is the solver's stopping measure (pdhg eps, ipm mu, ellipsoid rho). */
export interface NumericRow {
  iteration: number;
  /** pdhg: a Halpern restart happened at this iterate */
  restart?: boolean;
  x: number;
  y: number;
  objective: number;
  infeasibility: number;
  convergence: number;
}

/**
 * One printed section: a header line, one row per iterate (preformatted text
 * or the columns to format), the closing lines that are not iterates, and a
 * footer. A log with several sections is a phased run (simplex).
 */
export interface LogSection {
  header: string;
  rows: string[] | NumericRow[];
  notes?: string[] | undefined;
  footer?: string | undefined;
}

export type SolverLog = LogSection[];

export interface SolverResult {
  iterations: Float64Array[];
  log: SolverLog;
  /**
   * The height the 3D view lifts each iterate above the floor: the solver's stopping measure (pdhg
   * eps, ipm mu, ellipsoid rho) or the central path's barrier term. Absent for simplex, drawn flat.
   */
  convergence?: number[] | undefined;
  /** a phase label per iterate: simplex's phase, pdhg's basis hash */
  phases?: number[] | undefined;
  restartIndices?: number[] | undefined;
  /** [cx, cy, p11, p12, p22] per iterate (ellipsoid family) */
  ellipsoids?: Float64Array | undefined;
  /** the localizing polygon per iterate (cutting planes): [x, y] pairs at polygonOffsets[i] * 2 .. polygonOffsets[i + 1] * 2 */
  polygonPoints?: Float64Array | undefined;
  polygonOffsets?: Uint32Array | undefined;
  status?: "optimal" | "unbounded" | "infeasible" | undefined;
  mode?: "primal" | "dual" | undefined;
}
