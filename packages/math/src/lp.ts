// Seidel's randomized incremental linear program, for the tiny dense LPs the
// cutting-plane solvers need: the upper bound `max c'x` over a localizing
// polyhedron (2 variables) and the Chebyshev center of one (3 variables).
//
// Expected O(n! m) — linear in the number of constraints for fixed n, which is
// what makes it affordable to call once or twice per solver iteration as the
// cut list grows. Vertex enumeration would be O(m^n) per call and is hopeless
// by a few hundred cuts.
//
// The randomization is seeded, not ambient: the same problem must produce the
// same answer every time, or the objective-rotation animation would jitter.

const VIOLATION_TOLERANCE = 1e-9;
const DEGENERATE_COEFFICIENT = 1e-12;

// Each row is [a_0, ..., a_{n-1}, b], meaning a'x <= b.
export type LpRow = readonly number[];

export type SmallLpResult =
  | { status: "optimal"; x: Float64Array; value: number }
  | { status: "infeasible" };

function makeRandom(seed: number) {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function shuffledIndices(count: number, random: () => number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const swap = order[i]!;
    order[i] = order[j]!;
    order[j] = swap;
  }
  return order;
}

// Substitute x_k = (row_n - sum_{j != k} row_j x_j) / row_k into `target`,
// dropping coordinate k. Used for both constraints and the objective.
function eliminate(
  target: LpRow,
  row: LpRow,
  k: number,
  n: number,
): number[] {
  const scale = target[k]! / row[k]!;
  const reduced: number[] = [];
  for (let j = 0; j < n; j++) {
    if (j === k) continue;
    reduced.push(target[j]! - scale * row[j]!);
  }
  reduced.push(target[n]! - scale * row[n]!);
  return reduced;
}

// The eliminated coordinate is still one of the original variables, so it is
// still boxed; re-express |x_k| <= bound in the remaining coordinates.
function boxRowsForEliminated(
  row: LpRow,
  k: number,
  n: number,
  bound: number,
): number[][] {
  const pivot = row[k]!;
  const rest: number[] = [];
  for (let j = 0; j < n; j++) if (j !== k) rest.push(row[j]!);

  const upper = rest.map((value) => (pivot > 0 ? -value : value));
  upper.push(pivot > 0 ? bound * pivot - row[n]! : row[n]! - bound * pivot);

  const lower = rest.map((value) => (pivot > 0 ? value : -value));
  lower.push(pivot > 0 ? row[n]! + bound * pivot : -bound * pivot - row[n]!);

  return [upper, lower];
}

function solveRecursive(
  rows: LpRow[],
  n: number,
  objective: readonly number[],
  bound: number,
  random: () => number,
): Float64Array | null {
  if (n === 1) {
    let low = -bound;
    let high = bound;
    for (const row of rows) {
      const a = row[0]!;
      const b = row[1]!;
      if (Math.abs(a) < DEGENERATE_COEFFICIENT) {
        if (-b > VIOLATION_TOLERANCE) return null;
        continue;
      }
      if (a > 0) high = Math.min(high, b / a);
      else low = Math.max(low, b / a);
    }
    if (low > high + VIOLATION_TOLERANCE) return null;
    return Float64Array.of(objective[0]! >= 0 ? high : low);
  }

  // with no constraints yet the optimum is the box corner along the objective
  const x = new Float64Array(n);
  for (let j = 0; j < n; j++) x[j] = objective[j]! >= 0 ? bound : -bound;

  const processed: LpRow[] = [];
  for (const index of shuffledIndices(rows.length, random)) {
    const row = rows[index]!;
    let violation = -row[n]!;
    for (let j = 0; j < n; j++) violation += row[j]! * x[j]!;
    if (violation <= VIOLATION_TOLERANCE) {
      processed.push(row);
      continue;
    }

    // the new optimum lies on this constraint's hyperplane: eliminate the
    // coordinate with the largest coefficient and re-solve one dimension down
    let pivot = 0;
    for (let j = 1; j < n; j++) {
      if (Math.abs(row[j]!) > Math.abs(row[pivot]!)) pivot = j;
    }
    if (Math.abs(row[pivot]!) < DEGENERATE_COEFFICIENT) return null;

    const reducedRows: LpRow[] = processed.map((p) =>
      eliminate(p, row, pivot, n),
    );
    reducedRows.push(...boxRowsForEliminated(row, pivot, n, bound));
    const reducedObjective = eliminate(objective, row, pivot, n);
    const sub = solveRecursive(
      reducedRows,
      n - 1,
      reducedObjective,
      bound,
      random,
    );
    if (!sub) return null;

    let restIndex = 0;
    let sum = 0;
    for (let j = 0; j < n; j++) {
      if (j === pivot) continue;
      x[j] = sub[restIndex++]!;
      sum += row[j]! * x[j]!;
    }
    x[pivot] = (row[n]! - sum) / row[pivot]!;
    processed.push(row);
  }
  return x;
}

/**
 * Maximize `objective' x` subject to every row's `a'x <= b`, over the box
 * `|x_j| <= bound`. The box is what makes the problem bounded, so pick it large
 * enough to be inert unless you mean it as a constraint.
 */
export function solveSmallLp(
  objective: readonly number[],
  rows: readonly LpRow[],
  bound: number,
  seed = 1,
): SmallLpResult {
  const n = objective.length;
  if (n === 0) return { status: "optimal", x: new Float64Array(0), value: 0 };
  const objectiveRow = [...objective, 0];
  const x = solveRecursive(
    rows.map((row) => row),
    n,
    objectiveRow,
    bound,
    makeRandom(seed),
  );
  if (!x) return { status: "infeasible" };
  let value = 0;
  for (let j = 0; j < n; j++) value += objective[j]! * x[j]!;
  return { status: "optimal", x, value };
}

/**
 * The center of a largest ball inscribed in `{x : a'x <= b}`, as the LP
 * `max r s.t. a'x + r|a| <= b`. A negative radius means the polyhedron has no
 * interior (it is empty or flat), which the cutting-plane solvers read as "the
 * localizing set is exhausted".
 */
export function chebyshevCenter(
  rows: readonly LpRow[],
  dimension: number,
  bound: number,
  seed = 1,
): { center: Float64Array; radius: number } | null {
  const lifted: number[][] = rows.map((row) => {
    let norm = 0;
    for (let j = 0; j < dimension; j++) norm += row[j]! * row[j]!;
    const lift = [...row.slice(0, dimension), Math.sqrt(norm), row[dimension]!];
    return lift;
  });
  const objective = new Array(dimension + 1).fill(0);
  objective[dimension] = 1;
  const result = solveSmallLp(objective, lifted, bound, seed);
  if (result.status === "infeasible") return null;
  return {
    center: result.x.slice(0, dimension),
    radius: result.x[dimension]!,
  };
}
