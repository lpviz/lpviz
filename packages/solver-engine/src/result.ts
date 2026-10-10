// The one shape every engine returns: the iterates it visited plus the log it
// prints. The app flattens the iterates for the viewport and renders the log.

/** The columns of one iterate's log row. `convergence` is the solver's stopping measure (pdhg eps, ipm mu, ellipsoid rho). */
export interface NumericRow {
  iteration: number;
  /** pdhg: a Halpern restart happened at this iterate */
  restart?: boolean;
  /** the iterate's coordinates, one per variable */
  point: Float64Array;
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
  iterates: Float64Array[];
  log: SolverLog;
  /**
   * The height the 3D view lifts each iterate above the floor: the solver's stopping measure (pdhg
   * eps, ipm mu, ellipsoid rho) or the central path's barrier term. Absent for simplex, drawn flat.
   */
  convergence?: number[] | undefined;
  /** a phase label per iterate: simplex's phase, pdhg's basis hash */
  phases?: number[] | undefined;
  restartIndices?: number[] | undefined;
  /** the ellipsoid family's shape per iterate, packed as ellipsoidStride(n) values (see localization.ts) */
  ellipsoids?: Float64Array | undefined;
  /** the cutting planes' localizing set per iterate, localizingSetStride(n) values per entry between localizingSetOffsets[i] and [i + 1] */
  localizingSetPoints?: Float64Array | undefined;
  localizingSetOffsets?: Uint32Array | undefined;
  /** simplex: how the run ended */
  status?: "optimal" | "unbounded" | "infeasible" | undefined;
  /** simplex: which LP it walked */
  mode?: "primal" | "dual" | undefined;
}

/** The lockstep record of a run: one point, one log row and one convergence measure per iterate. */
export class NumericTrace {
  readonly iterates: Float64Array[] = [];
  readonly rows: NumericRow[] = [];
  readonly convergence: number[] = [];

  get count(): number {
    return this.iterates.length;
  }

  record(point: Float64Array, objective: number, infeasibility: number, convergence: number): void {
    this.rows.push({ iteration: this.iterates.length + 1, point, objective, infeasibility, convergence });
    this.iterates.push(point);
    this.convergence.push(convergence);
  }

  /** Mark the last recorded iterate as a restart (pdhg's Halpern scheme). */
  markRestart(): void {
    const last = this.rows[this.rows.length - 1];
    if (last) last.restart = true;
  }

  result(header: string, footer: string, extras: Partial<SolverResult> = {}): SolverResult {
    return { iterates: this.iterates, convergence: this.convergence, log: [{ header, rows: this.rows, footer }], ...extras };
  }
}
