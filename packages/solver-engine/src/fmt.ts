// The text of the solver logs: column formatting, headers, footers.

import { variableName } from "@lpviz/math/vec";
import type { NumericRow } from "./result";

/** Fixed-point with an explicit sign, right-aligned: "   -4.00". */
const fmtFixed = (value: number, width: number, decimals: number) => ((value >= 0 ? "+" : "") + value.toFixed(decimals)).padStart(width);
/** Exponent notation with an explicit sign, right-aligned: "   +1.2e+1". */
const fmtExp = (value: number, width: number, decimals: number) => ((value >= 0 ? "+" : "") + value.toExponential(decimals)).padStart(width);
/** Exponent notation without a sign, for measures that are never negative: "    9.6e-10". */
export const fmtExpUnsigned = (value: number, width: number, decimals: number) => value.toExponential(decimals).padStart(width);

export const ITERATION_COLUMN_WIDTH = 5;
const COORDINATE_DECIMALS = 2;

/** The iteration column: the number plus a marker ("d" for a guarded simplex pivot, "r" for a PDHG restart). */
export const fmtIteration = (iteration: number, marker = "") => `${iteration}${marker}`.padStart(ITERATION_COLUMN_WIDTH);

// Column widths of the numeric logs, by variable count: three coordinates need narrower columns so a
// row still fits the sidebar log beside its scrollbar.
export const logColumnWidths = (n: number) => (n >= 3 ? { coordinate: 7, measure: 8 } : { coordinate: 8, measure: 10 });

/** The coordinate columns of a log header, one per variable. */
function coordinateHeaders(n: number): string {
  const { coordinate } = logColumnWidths(n);
  return Array.from({ length: n }, (_, j) => variableName(j).padStart(coordinate)).join(" ");
}

/** The columns every log's header shares after the iteration: the coordinates and the objective. */
export function iterateHeaders(n: number): string {
  const { measure } = logColumnWidths(n);
  return `${coordinateHeaders(n)} ${"Obj".padStart(measure)}`;
}

/** The header of a numeric log: iteration, the coordinates, the objective, the infeasibility and the solver's measure. */
export function numericLogHeader(n: number, measure: string): string {
  const { measure: width } = logColumnWidths(n);
  return `${"Iter".padStart(ITERATION_COLUMN_WIDTH)} ${iterateHeaders(n)} ${"Infeas".padStart(width)} ${measure.padStart(width)}`;
}

/** The coordinate columns of one log row. */
function fmtCoordinates(point: ArrayLike<number>, width: number): string {
  return Array.from(point, (value) => fmtFixed(value, width, COORDINATE_DECIMALS)).join(" ");
}

/** One iterate's columns under iterateHeaders: its coordinates and objective. */
export function fmtIterate(point: ArrayLike<number>, objective: number): string {
  const { coordinate, measure } = logColumnWidths(point.length);
  return `${fmtCoordinates(point, coordinate)} ${fmtExp(objective, measure, 1)}`;
}

/** One row of a numeric log, under numericLogHeader's columns. */
export function formatNumericRow(row: NumericRow): string {
  const { measure } = logColumnWidths(row.point.length);
  return `${fmtIteration(row.iteration, row.restart ? "r" : "")} ${fmtIterate(row.point, row.objective)} ${fmtExp(row.infeasibility, measure, 1)} ${fmtExpUnsigned(row.convergence, measure, 1)}`;
}

export function formatMilliseconds(milliseconds: number) {
  return `${Math.round(milliseconds)}ms`;
}

/** "Converged to optimal solution in 12ms / 7 iterations", or "<stopped> after 7 iterations in 12ms". */
export function solveFooter(converged: boolean, iterationCount: number, solveTime: number, stopped = "Did not converge") {
  const elapsed = formatMilliseconds(solveTime);
  return converged ? `Converged to optimal solution in ${elapsed} / ${iterationCount} iterations` : `${stopped} after ${iterationCount} iterations in ${elapsed}`;
}

// the widest row set a log row lists in full, so a row stays within the column the panel fits
const ROW_SET_WIDTH = 11;

/**
 * A set of constraint rows, 1-based as the problem panel lists them: "2,5", "-" when empty, "14 rows"
 * past the column, padded to the column so every row of a log is as wide as the panel's fit samples.
 */
export function fmtRowSet(rows: readonly number[]): string {
  const list = rows.map((row) => row + 1).join(",");
  return (rows.length === 0 ? "-" : list.length <= ROW_SET_WIDTH ? list : `${rows.length} rows`).padEnd(ROW_SET_WIDTH);
}

/** The header over a fmtRowSet column. */
export const rowSetHeader = (label: string): string => label.padEnd(ROW_SET_WIDTH);
