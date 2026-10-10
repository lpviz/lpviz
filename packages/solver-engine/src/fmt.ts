// The text of the solver logs: column formatting, headers, footers.

import { variableName } from "@lpviz/math/vec";

/** Fixed-point with an explicit sign, right-aligned: "   -4.00". */
const fmtFixed = (value: number, width: number, decimals: number) => ((value >= 0 ? "+" : "") + value.toFixed(decimals)).padStart(width);
/** Exponent notation with an explicit sign, right-aligned: "   +1.2e+1". */
export const fmtExp = (value: number, width: number, decimals: number) => ((value >= 0 ? "+" : "") + value.toExponential(decimals)).padStart(width);
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
export function coordinateHeaders(n: number): string {
  const { coordinate } = logColumnWidths(n);
  return Array.from({ length: n }, (_, j) => variableName(j).padStart(coordinate)).join(" ");
}

/** The header of a numeric log: iteration, the coordinates, the objective, the infeasibility and the solver's measure. */
export function numericLogHeader(n: number, measure: string): string {
  const { measure: width } = logColumnWidths(n);
  return `${"Iter".padStart(ITERATION_COLUMN_WIDTH)} ${coordinateHeaders(n)} ${"Obj".padStart(width)} ${"Infeas".padStart(width)} ${measure.padStart(width)}`;
}

/** The coordinate columns of one log row. */
export function fmtCoordinates(point: ArrayLike<number>, width: number): string {
  return Array.from(point, (value) => fmtFixed(value, width, COORDINATE_DECIMALS)).join(" ");
}

export function formatMilliseconds(milliseconds: number) {
  return `${Math.round(milliseconds)}ms`;
}

/** "Converged to optimal solution in 12ms / 7 iterations", or "<stopped> after 7 iterations in 12ms". */
export function solveFooter(converged: boolean, iterationCount: number, solveTime: number, stopped = "Did not converge") {
  const elapsed = formatMilliseconds(solveTime);
  return converged ? `Converged to optimal solution in ${elapsed} / ${iterationCount} iterations` : `${stopped} after ${iterationCount} iterations in ${elapsed}`;
}
