const sgn = (v: number) => (v >= 0 ? "+" : "");

export const fmtIntL = (v: number, w: number) => String(v).padEnd(w);
export const fmtStr = (v: string, w: number) => v.padStart(w);
export const fmtStrL = (v: string, w: number) => v.padEnd(w);
const fmtF = (v: number, w: number, d: number) => (sgn(v) + v.toFixed(d)).padStart(w);
export const fmtE = (v: number, w: number, d: number, signed = true) => ((signed && v >= 0 ? "+" : "") + v.toExponential(d)).padStart(w);

const COORDINATE_LABELS = ["x", "y", "z"];

// Column widths of the numeric logs, by variable count: three coordinates need narrower columns so a
// row still fits the sidebar log beside its scrollbar.
export const logColumnWidths = (n: number) => (n >= 3 ? { coordinate: 7, measure: 8 } : { coordinate: 8, measure: 10 });

/** The coordinate columns of a log header, one per variable. */
export function coordinateHeaders(n: number): string {
  const { coordinate } = logColumnWidths(n);
  return Array.from({ length: n }, (_, j) => fmtStr(COORDINATE_LABELS[j] ?? `x${j + 1}`, coordinate)).join(" ");
}

/** The header of a numeric log: iteration, the coordinates, the objective, the infeasibility and the solver's measure. */
export function numericLogHeader(n: number, measure: string): string {
  const { measure: width } = logColumnWidths(n);
  return `${fmtStr("Iter", 5)} ${coordinateHeaders(n)} ${fmtStr("Obj", width)} ${fmtStr("Infeas", width)} ${fmtStr(measure, width)}`;
}

/** The coordinate columns of one log row. */
export function fmtCoordinates(point: ArrayLike<number>, width: number, decimals = 2): string {
  return Array.from(point, (value) => fmtF(value, width, decimals)).join(" ");
}
