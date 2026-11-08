// Megiddo's prune-and-search (Megiddo 1983, "Linear-time algorithms for linear programming in R³
// and related problems"; Dyer 1984 independently) on `max c'x s.t. Ax <= b` in the plane: a
// deterministic linear-time LP algorithm.
//
// Turn the plane so the objective points straight up. Each constraint is then a "ceiling"
// (y below a line), a "floor" (y above one) or a vertical wall, and the LP asks for the highest
// point of the lowest ceiling F(x) that is still above the highest floor G(x). Each round:
//   1. pair up the ceilings (and the floors), and find where each pair's lines cross;
//   2. test the vertical line through the median crossing x_m: F and G there, with their slopes,
//      say on which side of it the optimum lies (or that x_m is optimal, or that the LP is empty);
//   3. in every pair that crosses on the far side, one line can never be the lowest ceiling (highest
//      floor) on the near side: drop it.
// Half the pairs cross on the far side, so each round drops a quarter of the lines, and the rounds
// cost m + 3m/4 + 9m/16 + ... = O(m) in all. The x-range still in play, a slab, shrinks with every
// test; it is drawn as the localizing set. A handful of lines is solved by brute force at the end.
//
// The search needs F and G bounded, so the run adds a box, half again the size of the region
// (as Seidel's algorithm does, see seidel.ts): an optimum on the box means the LP is unbounded.

import { denseFromConstraints } from "@lpviz/math/blas";
import type { Constraint } from "@lpviz/math/types";
import { fmtIterate, fmtIteration, ITERATION_COLUMN_WIDTH, iterateHeaders, solveFooter } from "./fmt";
import { FloatBlock, iteratesOf, type SolverResult } from "./result";
import { startingBox } from "./seidel";

export interface MegiddoOptions {
  tol: number;
}

/** A line y = slope·x + intercept in the turned plane. */
type Line = { slope: number; intercept: number };

const BRUTE_FORCE_LINES = 6;
const at = (line: Line, x: number) => line.slope * x + line.intercept;
const crossing = (p: Line, q: Line) => (q.intercept - p.intercept) / (p.slope - q.slope);

function median(values: number[]): number {
  const sorted = [...values].sort((p, q) => p - q);
  return sorted[(sorted.length - 1) >> 1]!;
}

/** F or G at x: the extreme value and the least and greatest slope among the lines attaining it. */
function envelope(lines: readonly Line[], x: number, lowest: boolean, tol: number) {
  let value = lowest ? Infinity : -Infinity;
  for (const line of lines) value = lowest ? Math.min(value, at(line, x)) : Math.max(value, at(line, x));
  let least = Infinity;
  let greatest = -Infinity;
  for (const line of lines) {
    if (Math.abs(at(line, x) - value) <= tol * (1 + Math.abs(value))) {
      least = Math.min(least, line.slope);
      greatest = Math.max(greatest, line.slope);
    }
  }
  return { value, least, greatest };
}

type Verdict = "left" | "right" | "here" | "empty";

/** Where the optimum lies relative to the vertical line at x. */
function test(ceilings: readonly Line[], floors: readonly Line[], x: number, tol: number): Verdict {
  const F = envelope(ceilings, x, true, tol);
  const G = envelope(floors, x, false, tol);
  if (G.value <= F.value + tol * (1 + Math.abs(F.value))) {
    // feasible at x: climb F, which is concave; its right slope is the least active slope
    if (F.least > tol) return "right";
    if (F.greatest < -tol) return "left";
    return "here";
  }
  // infeasible at x: G - F > 0 here; go where it decreases, if it does
  if (G.greatest - F.least < -tol) return "right";
  if (G.least - F.greatest > tol) return "left";
  return "empty";
}

/**
 * Prune against the slab lo <= x <= hi: a pair crossing outside it is ordered all the way across, so
 * the line that cannot attain the envelope there (the upper ceiling, the lower floor) goes.
 */
function prune(pairs: readonly [Line, Line][], unpaired: readonly Line[], lo: number, hi: number, lowest: boolean): Line[] {
  const kept = [...unpaired];
  for (const [p, q] of pairs) {
    const cross = crossing(p, q);
    if (cross > lo && cross < hi) {
      kept.push(p, q);
      continue;
    }
    // to the right of the crossing the steeper line is above, to the left the flatter one
    const steeper = p.slope > q.slope ? p : q;
    const flatter = steeper === p ? q : p;
    const upper = cross <= lo ? steeper : flatter;
    const lower = upper === p ? q : p;
    kept.push(lowest ? lower : upper);
  }
  return kept;
}

/** Pair up lines, dropping one of every parallel pair outright; returns the pairs and the leftover. */
function pairUp(lines: readonly Line[], lowest: boolean, tol: number): { pairs: [Line, Line][]; unpaired: Line[] } {
  const pairs: [Line, Line][] = [];
  const unpaired: Line[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const p = lines[i]!;
    const q = lines[i + 1]!;
    if (Math.abs(p.slope - q.slope) <= tol) unpaired.push(lowest === p.intercept < q.intercept ? p : q);
    else pairs.push([p, q]);
  }
  if (lines.length % 2) unpaired.push(lines.at(-1)!);
  return { pairs, unpaired };
}

/** Megiddo's prune-and-search on `max objective'x s.t. Ax <= b`, for two variables. */
export function megiddo(constraints: readonly Constraint[], objective: Float64Array, { tol }: MegiddoOptions): SolverResult {
  const { A, b } = denseFromConstraints(constraints);
  if (A.cols !== 2) throw new Error("Megiddo's method is a planar algorithm: it needs exactly two variables.");
  const norm = Math.hypot(objective[0]!, objective[1]!);
  if (!(norm > 0)) throw new Error("Megiddo's method needs a nonzero objective to turn the plane by.");
  const startTime = performance.now();
  // up = c/|c|, across = up turned a quarter clockwise; a point is x·across + y·up
  const up = [objective[0]! / norm, objective[1]! / norm] as const;
  const across = [up[1], -up[0]] as const;
  const toPlane = (x: number, y: number) => Float64Array.of(x * across[0] + y * up[0], x * across[1] + y * up[1]);

  const rows = Array.from({ length: A.rows }, (_, i) => ({ a: [A.data[2 * i]!, A.data[2 * i + 1]!] as const, b: b[i]! }));
  const box = startingBox(
    rows.map(({ a, b: bi }) => ({ a: Float64Array.of(a[0], a[1]), b: bi })),
    2,
    tol,
  );
  const all = [...rows, ...box.map(({ a, b: bi }) => ({ a: [a[0]!, a[1]!] as const, b: bi }))];

  const ceilings: Line[] = [];
  const floors: Line[] = [];
  let current = { ceilings, floors };
  let lo = -Infinity;
  let hi = Infinity;
  for (const { a, b: bi } of all) {
    const ax = a[0] * across[0] + a[1] * across[1];
    const ay = a[0] * up[0] + a[1] * up[1];
    if (Math.abs(ay) <= 1e-12 * Math.hypot(a[0], a[1])) {
      // a wall: ax·x <= b
      if (ax > 0) hi = Math.min(hi, bi / ax);
      else if (ax < 0) lo = Math.max(lo, bi / ax);
      continue;
    }
    // ay·y <= b - ax·x: a ceiling when ay > 0, a floor when ay < 0
    (ay > 0 ? ceilings : floors).push({ slope: -ax / ay, intercept: bi / ay });
  }

  const iterates = new FloatBlock(2);
  const slabs: number[] = [];
  const offsets = [0];
  const log: string[] = [];
  const header = `${"Iter".padStart(ITERATION_COLUMN_WIDTH)} ${iterateHeaders(2)} Lines  Side\n`;
  // the slab lo <= x <= hi, cut down to the box, as the polygon drawn for the iterate
  const reach = Math.abs(box[0]!.b) * 2;
  const recordSlab = () => {
    const left = Math.max(lo, -reach);
    const right = Math.min(hi, reach);
    for (const [x, y] of [
      [left, -reach],
      [right, -reach],
      [right, reach],
      [left, reach],
    ] as const) {
      const p = toPlane(x, y);
      slabs.push(p[0]!, p[1]!);
    }
    offsets.push(slabs.length / 2);
  };
  const record = (x: number, y: number, side: string) => {
    const p = toPlane(x, y);
    iterates.push(p);
    recordSlab();
    log.push(`${fmtIteration(log.length + 1)} ${fmtIterate(p, norm * y)} ${String(current.ceilings.length + current.floors.length).padStart(5)}  ${side}`);
  };

  let status: "optimal" | "infeasible" | "unbounded" | undefined;
  let optimum: { x: number; lines: Line[] } | null = null;

  while (current.ceilings.length + current.floors.length > BRUTE_FORCE_LINES) {
    const c = pairUp(current.ceilings, true, tol);
    const f = pairUp(current.floors, false, tol);
    const crossings = [...c.pairs, ...f.pairs].map(([p, q]) => crossing(p, q)).filter((x) => x > lo && x < hi);
    if (crossings.length > 0) {
      const xm = median(crossings);
      const verdict = test(current.ceilings, current.floors, xm, tol);
      record(xm, envelope(current.ceilings, xm, true, tol).value, verdict === "here" ? "optimum" : verdict);
      if (verdict === "here") {
        optimum = { x: xm, lines: current.ceilings };
        break;
      }
      if (verdict === "empty") {
        status = "infeasible";
        break;
      }
      if (verdict === "right") lo = xm;
      else hi = xm;
    } else if (c.pairs.length + f.pairs.length === 0) {
      // nothing left to pair (all parallel): brute force the rest
      current = { ceilings: c.unpaired, floors: f.unpaired };
      break;
    }
    // every pair crossing outside the slab loses a line, which is at least the quarter of them
    // crossing on the median's far side
    current = { ceilings: prune(c.pairs, c.unpaired, lo, hi, true), floors: prune(f.pairs, f.unpaired, lo, hi, false) };
  }

  if (!status && !optimum) {
    // brute force: the best feasible point among the few crossings left in the slab, and its ends
    const lines = [...current.ceilings, ...current.floors];
    const candidates = [lo, hi].filter(Number.isFinite);
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        if (Math.abs(lines[i]!.slope - lines[j]!.slope) > tol) candidates.push(crossing(lines[i]!, lines[j]!));
      }
    }
    let best: number | null = null;
    let bestValue = -Infinity;
    for (const x of candidates) {
      if (x < lo - tol || x > hi + tol) continue;
      const F = envelope(current.ceilings, x, true, tol).value;
      const G = envelope(current.floors, x, false, tol).value;
      if (G <= F + tol * (1 + Math.abs(F)) && F > bestValue) {
        best = x;
        bestValue = F;
      }
    }
    if (best === null) status = "infeasible";
    else optimum = { x: best, lines: current.ceilings };
  }

  if (optimum) {
    const y = envelope(optimum.lines, optimum.x, true, tol).value;
    // every vertex of the region is strictly inside the box, so an optimum on it is one the
    // constraints leave open (the box row itself may have been pruned by then)
    const radius = box[0]!.b;
    const onBox = toPlane(optimum.x, y).some((v) => Math.abs(v) >= radius * (1 - 1e-9));
    status = onBox ? "unbounded" : "optimal";
    record(optimum.x, y, onBox ? "box" : "optimum");
  }

  const summary =
    status === "optimal"
      ? `Optimal after ${log.length - 1} median test${log.length === 2 ? "" : "s"}`
      : status === "infeasible"
        ? "The highest floor stays above the lowest ceiling on both sides of the test line: the LP is infeasible"
        : "The optimum is on the starting box: no constraint bounds the objective, so the LP is unbounded";
  const footer = [summary, solveFooter(status === "optimal", iterates.count, performance.now() - startTime, "Stopped")].join("\n");
  return {
    iterates: iteratesOf(iterates),
    log: [{ header, rows: log, footer }],
    status,
    localizingSets: { points: Float64Array.from(slabs), offsets: Uint32Array.from(offsets), count: offsets.length - 1, stride: 2 },
  };
}
