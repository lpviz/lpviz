// Pivoting on the bases of `max c'x s.t. Ax <= b` itself, the walk criss-cross and the primal-dual
// active-set method share. A basis is n linearly independent rows held tight: its point is the
// vertex of the constraint arrangement where they meet, inside the region or not, and its
// multipliers are the y with A_Bᵀy = c. The basis is optimal when the point satisfies every other
// row (primal feasible) and the multipliers are nonnegative (dual feasible). Neither method keeps
// either kind of feasibility along the way, which is why their paths leave the region.
//
// In tableau terms the variables are the row slacks, with x free and always basic: row i tight is
// slack i nonbasic. So a row outside the basis that the point breaks is a basic slack below zero,
// and a negative multiplier is a nonbasic slack with a positive reduced cost.

import { denseFromConstraints, type DenseMatrix, dot, rowDot, selectRows } from "@lpviz/math/blas";
import { invertDenseMatrix, trySolveDenseSystem } from "@lpviz/math/lapack";
import type { Constraint } from "@lpviz/math/types";
import { fmtIterate, fmtRowSet, rowSetHeader, fmtIteration, ITERATION_COLUMN_WIDTH, iterateHeaders } from "./fmt";
import { assertAtMost, MAX_ITERATIONS } from "./limits";
import { FloatBlock, iteratesOf, type SolverResult } from "./result";

/** A basis evaluated: its rows, point and multipliers, and the rows that break each kind of feasibility. */
export interface BasisState {
  /** the tight rows, ascending; position p of the multipliers and of A_B is rows[p] */
  rows: number[];
  point: Float64Array;
  multipliers: Float64Array;
  /** A_B⁻¹, n × n row-major */
  inverse: Float64Array;
  /** the rows outside the basis the point breaks, ascending */
  primalInfeasible: number[];
  /** the basic rows whose multiplier is negative, ascending */
  dualInfeasible: number[];
}

/** Why a walk stopped short of an optimal basis: the row the certificate was read from. */
export type Certificate = { status: "infeasible" | "unbounded"; row: number };

/** The next basis and the marker its log row carries, or the certificate that ends the walk. */
export type BasisStep = { rows: number[]; marker?: string } | Certificate;

/**
 * The order the pivot rule ranks rows in: "first" scans from row 1 (Terlaky's least-index rule),
 * "last" from the last row. Any fixed order keeps criss-cross finite.
 */
export const INDEX_ORDERS = ["first", "last"] as const;
export type IndexOrder = (typeof INDEX_ORDERS)[number];

export interface VertexLp {
  A: DenseMatrix;
  b: Float64Array;
  c: Float64Array;
  tol: number;
  order: IndexOrder;
}

// the rows' indices in the order the rule ranks them
const ranked = (count: number, order: IndexOrder) => Array.from({ length: count }, (_, k) => (order === "first" ? k : count - 1 - k));

const SINGULAR_ROW_TOLERANCE = 1e-9;

/** The basis on `rows`, or null when they are not linearly independent. */
function evaluateBasis({ A, b, c, tol }: VertexLp, rows: readonly number[]): BasisState | null {
  const n = A.cols;
  const matrix = new Float64Array(n * n);
  rows.forEach((row, p) => matrix.set(A.data.subarray(row * n, (row + 1) * n), p * n));
  const inverse = new Float64Array(n * n);
  try {
    invertDenseMatrix(matrix, n, inverse);
  } catch {
    return null;
  }
  // x = A_B⁻¹ b_B and y = A_B⁻ᵀ c
  const point = new Float64Array(n);
  const multipliers = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    for (let p = 0; p < n; p++) {
      point[j]! += inverse[j * n + p]! * b[rows[p]!]!;
      multipliers[p]! += inverse[j * n + p]! * c[j]!;
    }
  }
  if (!point.every(Number.isFinite)) return null;

  const basic = new Set(rows);
  const primalInfeasible: number[] = [];
  for (let i = 0; i < A.rows; i++) {
    if (!basic.has(i) && rowDot(A, i, point) - b[i]! > tol * (1 + Math.abs(b[i]!))) primalInfeasible.push(i);
  }
  const dualInfeasible = rows.filter((_, p) => multipliers[p]! < -tol);
  return { rows: [...rows], point, multipliers, inverse, primalInfeasible, dualInfeasible };
}

/** The first n linearly independent rows among `candidates`, in their order, ascending; or null when they span less than n dimensions. */
export function firstIndependentRows(A: DenseMatrix, candidates: readonly number[] = ranked(A.rows, "first")): number[] | null {
  const n = A.cols;
  const rows: number[] = [];
  // an orthonormal basis of the chosen rows' span, by Gram-Schmidt
  const span: Float64Array[] = [];
  for (const i of candidates) {
    if (rows.length === n) break;
    const v = Float64Array.from(A.data.subarray(i * n, (i + 1) * n));
    const norm = Math.hypot(...v);
    for (const q of span) {
      let projection = 0;
      for (let j = 0; j < n; j++) projection += q[j]! * v[j]!;
      for (let j = 0; j < n; j++) v[j]! -= projection * q[j]!;
    }
    const residual = Math.hypot(...v);
    if (!(residual > SINGULAR_ROW_TOLERANCE * norm)) continue;
    span.push(v.map((value) => value / residual));
    rows.push(i);
  }
  return rows.length === n ? rows.sort((p, q) => p - q) : null;
}

const exchange = (rows: readonly number[], leaving: number, entering: number) => rows.map((row) => (row === leaving ? entering : row)).sort((p, q) => p - q);

/**
 * The least-index pivot (Terlaky's criss-cross rule), in the LP's index order: take the first row
 * that breaks either kind of feasibility, and exchange it with the first row that can repair it.
 * When none can, that row certifies the LP infeasible (a broken row no tight row can relax
 * towards) or unbounded (a negative multiplier whose row can be released along a ray no other row
 * stops).
 */
export function leastIndexPivot({ A, tol, order }: VertexLp, state: BasisState): BasisStep {
  const n = A.cols;
  const { rows, inverse, primalInfeasible, dualInfeasible } = state;
  const first = order === "first" ? (list: readonly number[]) => list[0] : (list: readonly number[]) => list.at(-1);
  const isPrimal = new Set(primalInfeasible);
  const broken = ranked(A.rows, order).find((i) => isPrimal.has(i) || dualInfeasible.includes(i))!;

  if (isPrimal.has(broken)) {
    // Releasing tight row rows[p] by a slack t moves the broken row's slack at rate w_p, w = A_B⁻ᵀ a_r:
    // a positive rate is one that can bring it back up to zero.
    const repairing = rows.filter((_, p) => {
      let rate = 0;
      for (let j = 0; j < n; j++) rate += inverse[j * n + p]! * A.data[broken * n + j]!;
      return rate > tol;
    });
    const leaving = first(repairing);
    return leaving === undefined ? { status: "infeasible", row: broken } : { rows: exchange(rows, leaving, broken) };
  }

  // Releasing the basic row with the negative multiplier moves the point along d = -A_B⁻¹ e_p, which
  // improves the objective; the first row outside the basis that d runs into takes its place.
  const p = rows.indexOf(broken);
  const basic = new Set(rows);
  for (const i of ranked(A.rows, order)) {
    if (basic.has(i)) continue;
    let rate = 0;
    for (let j = 0; j < n; j++) rate -= A.data[i * n + j]! * inverse[j * n + p]!;
    if (rate > tol) return { rows: exchange(rows, broken, i) };
  }
  return { status: "unbounded", row: broken };
}

/** Where the walk starts by default: the vertex where the first n independent rows in `order` meet, or null when the rows have none. */
export function defaultStartVertex(constraints: readonly Constraint[], order: IndexOrder): Float64Array | null {
  const { A, b } = denseFromConstraints(constraints);
  const rows = firstIndependentRows(A, ranked(A.rows, order));
  const point = new Float64Array(A.cols);
  return rows &&
    trySolveDenseSystem(
      selectRows(A, rows).data,
      A.cols,
      Float64Array.from(rows, (i) => b[i]!),
      point,
    )
    ? point
    : null;
}

/**
 * The LP as the walk reads it and the basis it starts from: the rows tight at `startVertex` when
 * they pin it down, else the first independent rows in the index order. An error when the rows have
 * no vertex at all.
 */
export function vertexLp(
  constraints: readonly Constraint[],
  objective: Float64Array,
  { tol, order, startVertex, name }: { tol: number; order: IndexOrder; startVertex: readonly number[] | null; name: string },
): { lp: VertexLp; start: number[] } {
  const { A, b } = denseFromConstraints(constraints);
  const tight = startVertex && ranked(A.rows, order).filter((i) => Math.abs(rowDot(A, i, startVertex) - b[i]!) <= tol * (1 + Math.abs(b[i]!)));
  const start = (tight && firstIndependentRows(A, tight)) ?? firstIndependentRows(A, ranked(A.rows, order));
  if (!start) throw new Error(`${name} needs ${A.cols} linearly independent constraints: the region has no vertex to start from.`);
  return { lp: { A, b, c: Float64Array.from(objective), tol, order }, start };
}

const COUNT_WIDTH = 4;

/**
 * Walk from `start`, taking `step` from every basis that is not optimal, until one is, a step
 * returns a certificate, or `maxit` bases have been visited. Each basis is one iterate, plotted at its point. The log row counts the
 * rows breaking primal and dual feasibility and lists the tight ones.
 */
export function walkVertexBases(
  lp: VertexLp,
  start: number[],
  maxit: number,
  step: (state: BasisState) => BasisStep,
  footerOf: (pivots: number, status: Certificate["status"] | "optimal" | "stopped") => string,
): SolverResult {
  assertAtMost("maxit", maxit, MAX_ITERATIONS);
  const n = lp.A.cols;
  const iterates = new FloatBlock(n);
  const header = `${"Iter".padStart(ITERATION_COLUMN_WIDTH)} ${iterateHeaders(n)} ${"Pinf".padStart(COUNT_WIDTH)} ${"Dinf".padStart(COUNT_WIDTH)} ${rowSetHeader("Tight")}\n`;
  const rows: string[] = [];
  let next: BasisStep = { rows: start };
  let note: string | null = null;
  let optimal = false;

  while (rows.length < maxit) {
    const state = evaluateBasis(lp, next.rows);
    if (!state) throw new Error(`The tight rows ${next.rows.map((row) => row + 1).join(", ")} are linearly dependent.`);
    const { point, primalInfeasible, dualInfeasible } = state;
    iterates.push(point);
    const counts = `${String(primalInfeasible.length).padStart(COUNT_WIDTH)} ${String(dualInfeasible.length).padStart(COUNT_WIDTH)}`;
    rows.push(`${fmtIteration(rows.length + 1, next.marker)} ${fmtIterate(point, dot(lp.c, point))} ${counts} ${fmtRowSet(state.rows)}`);

    if (primalInfeasible.length === 0 && dualInfeasible.length === 0) {
      optimal = true;
      break;
    }
    next = step(state);
    if ("status" in next) {
      note =
        next.status === "unbounded"
          ? `Row ${next.row + 1} has a negative multiplier, and releasing it opens a ray no other row stops: the LP is unbounded.`
          : `Row ${next.row + 1} is broken, and no tight row can be released towards it: the LP is infeasible.`;
      break;
    }
  }

  const status = "status" in next ? next.status : optimal ? "optimal" : undefined;
  const footer = footerOf(rows.length - 1, status ?? "stopped");
  const outcome = status === "unbounded" ? "Unbounded LP" : status === "infeasible" ? "Infeasible LP" : null;
  return {
    iterates: iteratesOf(iterates),
    log: [{ header, rows, footer: [note, footer, outcome].filter((line) => line !== null).join("\n") }],
    status,
  };
}
