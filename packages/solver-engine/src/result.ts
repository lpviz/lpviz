// The one shape every engine returns: the iterates it visited, as one flat block, plus the log it
// prints with its numeric rows as columns. Nothing downstream re-shapes them: the block is what the
// viewport draws, and the columns are what the log formats a row from when it scrolls into view.

import { numericLogHeader, solveFooter } from "./fmt";
import { assertAtMost, MAX_ITERATIONS } from "./limits";

/** The iterates as one flat block, `stride` coordinates each: iterate i is points[i * stride .. (i + 1) * stride). */
export interface Iterates {
  points: Float64Array;
  count: number;
  stride: number;
}

/**
 * The numeric rows of a log section as one column per measure, an entry per iterate; a row's
 * coordinates are its iterate's. A 100k-row log is four arrays, not 100k objects.
 */
export interface NumericRows {
  objective: Float64Array;
  infeasibility: Float64Array;
  /** the solver's stopping measure (pdhg eps, ipm mu, ellipsoid rho) */
  convergence: Float64Array;
  /** 1 where pdhg's Halpern scheme restarted at the iterate */
  restart: Uint8Array;
}

/** One numeric row as the client materializes it from the columns, to format it. */
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
 * One printed section: a header line, one row per iterate (preformatted text or the columns to
 * format), the closing lines that are not iterates, and a footer. A log with several sections is a
 * phased run (simplex).
 */
export interface LogSection {
  header: string;
  rows: string[] | NumericRows;
  notes?: string[] | undefined;
  footer?: string | undefined;
}

export interface SolverResult {
  iterates: Iterates;
  log: LogSection[];
  /**
   * The height the 3D view lifts each iterate above the floor: the solver's stopping measure (pdhg
   * eps, ipm mu, ellipsoid rho, PDAS's KKT residual) or the central path's barrier term. Absent for
   * the pivoting methods (simplex, criss-cross), drawn flat.
   */
  convergence?: Float64Array | undefined;
  /** a phase label per iterate: simplex's phase, pdhg's basis hash */
  phases?: number[] | undefined;
  restartIndices?: number[] | undefined;
  /** the ellipsoid family's shape per iterate */
  ellipsoids?: EllipsoidPath | undefined;
  /** the cutting planes' localizing set per iterate, once one was recorded */
  localizingSets?: LocalizingSetPath | undefined;
  /** the pivoting methods (simplex, criss-cross, PDAS): how the run ended */
  status?: "optimal" | "unbounded" | "infeasible" | undefined;
  /** simplex: which LP it walked */
  mode?: "primal" | "dual" | undefined;
}

// The ellipsoid family's shape per iterate, parallel to the iterates: element `i` is the center
// followed by the upper triangle of the symmetric shape matrix P of
// { x : (x - c)' P^-1 (x - c) <= 1 }, `stride` = ellipsoidStride(n) values ([cx, cy, p11, p12, p22]
// for two variables; see localization.ts).
export interface EllipsoidPath {
  data: Float64Array;
  count: number;
  stride: number;
}

// The cutting planes' localizing set per iterate: element `i` spans
// points[offsets[i] * stride .. offsets[i + 1] * stride), a closed polygon's [x, y] vertices for two
// variables (stride 2) and the half-spaces [a1..an, b] of the polyhedron otherwise (stride n + 1).
// The ellipsoid method records none: its localizing set is the ellipse already in EllipsoidPath.
export interface LocalizingSetPath {
  points: Float64Array;
  offsets: Uint32Array;
  count: number;
  stride: number;
}

const INITIAL_ROWS = 256;

/** A flat block of fixed-width rows that grows as rows are added; `finish` is the rows exactly, as one array. */
export class FloatBlock {
  data: Float64Array;
  count = 0;

  constructor(readonly stride: number) {
    this.data = new Float64Array(INITIAL_ROWS * stride);
  }

  /** Room for one more row: the index of its first value in `data`, which growing may have replaced. */
  add(): number {
    if (this.count * this.stride === this.data.length) {
      const grown = new Float64Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    return this.count++ * this.stride;
  }

  /** Append the row's first `stride` values. */
  push(row: ArrayLike<number>): void {
    const at = this.add();
    for (let k = 0; k < this.stride; k++) this.data[at + k] = row[k]!;
  }

  /** Append the last row again. */
  repeatLast(): void {
    const at = this.add();
    this.data.copyWithin(at, at - this.stride, at);
  }

  /** Row `i`, as a view. */
  rowAt(i: number): Float64Array {
    return this.data.subarray(i * this.stride, (i + 1) * this.stride);
  }

  /** The rows so far, exactly, as one fresh array. */
  finish(): Float64Array {
    return this.data.slice(0, this.count * this.stride);
  }
}

/** A block of points as a result's iterates. */
export const iteratesOf = (block: FloatBlock): Iterates => ({ points: block.finish(), count: block.count, stride: block.stride });

/**
 * How a run stopped, as its footer reads: converged or not, the stop's own lead when it is not the
 * plain "Did not converge" ("Stopped", "Localizing set exhausted"), and a line before or after the
 * standard one.
 */
export type Stop = { converged: boolean; lead?: string | undefined; before?: string | undefined; after?: string | undefined };

/**
 * The lockstep record of a run: one point and one row's measures per iterate, the clock the footer
 * reports, and the log's header for the `measure` the run stops on. Asks for the iteration cap up
 * front, so a run over it never starts.
 */
export class NumericTrace {
  private readonly points: FloatBlock;
  // objective, infeasibility, convergence
  private readonly measures = new FloatBlock(3);
  private readonly restarts: number[] = [];
  private readonly startTime = performance.now();

  constructor(
    stride: number,
    private readonly measure: string,
    maxit: number,
  ) {
    assertAtMost("maxit", maxit, MAX_ITERATIONS);
    this.points = new FloatBlock(stride);
  }

  get count(): number {
    return this.points.count;
  }

  /** Milliseconds since the run started recording. */
  get elapsedMs(): number {
    return performance.now() - this.startTime;
  }

  /** Iterate `i`, as a view. */
  pointAt(i: number): Float64Array {
    return this.points.rowAt(i);
  }

  record(point: ArrayLike<number>, objective: number, infeasibility: number, convergence: number): void {
    this.points.push(point);
    const at = this.measures.add();
    const { data } = this.measures;
    data[at] = objective;
    data[at + 1] = infeasibility;
    data[at + 2] = convergence;
  }

  /** Mark the last recorded iterate as a restart (pdhg's Halpern scheme). */
  markRestart(): void {
    this.restarts.push(this.count - 1);
  }

  /** The footer of a run that stopped as `stop` says, with the count and the clock as they stand now. */
  footerOf({ converged, lead, before, after }: Stop): string {
    const line = solveFooter(converged, this.count, this.elapsedMs, lead);
    return `${before ? `${before}\n` : ""}${line}${after ? `\n${after}` : ""}`;
  }

  /** The result of a run that stopped as `stop` says. */
  finish(stop: Stop, extras?: Partial<SolverResult>): SolverResult {
    return this.result(this.footerOf(stop), extras);
  }

  result(footer: string, extras: Partial<SolverResult> = {}): SolverResult {
    const count = this.count;
    const { data } = this.measures;
    const objective = new Float64Array(count);
    const infeasibility = new Float64Array(count);
    const convergence = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      objective[i] = data[i * 3]!;
      infeasibility[i] = data[i * 3 + 1]!;
      convergence[i] = data[i * 3 + 2]!;
    }
    const restart = new Uint8Array(count);
    for (const i of this.restarts) restart[i] = 1;
    const header = numericLogHeader(this.points.stride, this.measure);
    return { iterates: iteratesOf(this.points), convergence, log: [{ header, rows: { objective, infeasibility, convergence, restart }, footer }], ...extras };
  }
}
