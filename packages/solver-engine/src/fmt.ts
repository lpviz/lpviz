const sgn = (v: number) => (v >= 0 ? "+" : "");

export const fmtIntL = (v: number, w: number) => String(v).padEnd(w);
export const fmtStr = (v: string, w: number) => v.padStart(w);
export const fmtStrL = (v: string, w: number) => v.padEnd(w);
export const fmtF = (v: number, w: number, d: number) => (sgn(v) + v.toFixed(d)).padStart(w);
export const fmtE = (v: number, w: number, d: number, signed = true) => ((signed && v >= 0 ? "+" : "") + v.toExponential(d)).padStart(w);
