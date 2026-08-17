import { describe, expect, test } from "bun:test";
import { chebyshevCenter, solveSmallLp, type LpRow } from "../src/lp";

const BOUND = 1e4;

// brute force: every candidate vertex is the intersection of n constraints
function bruteForce(objective: number[], rows: LpRow[], n: number) {
  const boxed: LpRow[] = [...rows];
  for (let j = 0; j < n; j++) {
    const upper = new Array(n + 1).fill(0);
    upper[j] = 1;
    upper[n] = BOUND;
    const lower = new Array(n + 1).fill(0);
    lower[j] = -1;
    lower[n] = BOUND;
    boxed.push(upper, lower);
  }
  let best = -Infinity;
  const combos: number[][] = [];
  const build = (start: number, picked: number[]) => {
    if (picked.length === n) {
      combos.push([...picked]);
      return;
    }
    for (let i = start; i < boxed.length; i++) build(i + 1, [...picked, i]);
  };
  build(0, []);
  for (const combo of combos) {
    const A = combo.map((i) => boxed[i]!.slice(0, n) as number[]);
    const b = combo.map((i) => boxed[i]![n]!);
    const x = solveSquare(A, b, n);
    if (!x) continue;
    let feasible = true;
    for (const row of boxed) {
      let value = 0;
      for (let j = 0; j < n; j++) value += row[j]! * x[j]!;
      if (value > row[n]! + 1e-7) {
        feasible = false;
        break;
      }
    }
    if (!feasible) continue;
    let value = 0;
    for (let j = 0; j < n; j++) value += objective[j]! * x[j]!;
    best = Math.max(best, value);
  }
  return best;
}

function solveSquare(A: number[][], b: number[], n: number): number[] | null {
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(M[pivot]![col]!) < 1e-10) return null;
    [M[col], M[pivot]] = [M[pivot]!, M[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r]![col]! / M[col]![col]!;
      for (let c = col; c <= n; c++) M[r]![c] = M[r]![c]! - factor * M[col]![c]!;
    }
  }
  return Array.from({ length: n }, (_, j) => M[j]![n]! / M[j]![j]!);
}

function randomRows(count: number, n: number, rand: () => number): LpRow[] {
  return Array.from({ length: count }, () => {
    const row = Array.from({ length: n }, () => rand() * 2 - 1);
    row.push(0.5 + rand() * 2);
    return row;
  });
}

describe("solveSmallLp", () => {
  test("matches brute-force vertex enumeration in 2 and 3 variables", () => {
    let seed = 17;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (const n of [2, 3]) {
      for (let trial = 0; trial < 30; trial++) {
        const rows = randomRows(3 + Math.floor(rand() * 6), n, rand);
        const objective = Array.from({ length: n }, () => rand() * 2 - 1);
        const got = solveSmallLp(objective, rows, BOUND);
        const want = bruteForce(objective, rows, n);
        expect(got.status).toBe("optimal");
        if (got.status === "optimal") {
          expect(got.value).toBeCloseTo(want, 6);
        }
      }
    }
  });

  test("respects every constraint at the reported optimum", () => {
    let seed = 91;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let trial = 0; trial < 40; trial++) {
      const rows = randomRows(4 + Math.floor(rand() * 8), 2, rand);
      const objective = [rand() * 2 - 1, rand() * 2 - 1];
      const got = solveSmallLp(objective, rows, BOUND);
      expect(got.status).toBe("optimal");
      if (got.status !== "optimal") continue;
      for (const row of rows) {
        expect(row[0]! * got.x[0]! + row[1]! * got.x[1]!).toBeLessThanOrEqual(
          row[2]! + 1e-6,
        );
      }
    }
  });

  test("reports infeasible instead of returning a bogus point", () => {
    const rows: LpRow[] = [
      [1, 0, 1],
      [-1, 0, -2],
    ];
    expect(solveSmallLp([1, 0], rows, BOUND).status).toBe("infeasible");
  });

  test("is deterministic across repeated solves", () => {
    let seed = 5;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const rows = randomRows(10, 2, rand);
    const first = solveSmallLp([1, 0.3], rows, BOUND);
    for (let i = 0; i < 5; i++) {
      const again = solveSmallLp([1, 0.3], rows, BOUND);
      expect(again).toEqual(first);
    }
  });
});

describe("chebyshevCenter", () => {
  test("finds the incircle of a square", () => {
    // x in [-1, 3], y in [-2, 2]: square, so the incircle is unique
    const square: LpRow[] = [
      [1, 0, 3],
      [-1, 0, 1],
      [0, 1, 2],
      [0, -1, 2],
    ];
    const result = chebyshevCenter(square, 2, BOUND);
    expect(result).not.toBeNull();
    expect(result!.radius).toBeCloseTo(2, 6);
    expect(result!.center[0]!).toBeCloseTo(1, 6);
    expect(result!.center[1]!).toBeCloseTo(0, 6);
  });

  test("finds a largest incircle even where its center is not unique", () => {
    // 4 wide, 6 tall: radius is pinned at 2 but the circle slides in y
    const tall: LpRow[] = [
      [1, 0, 3],
      [-1, 0, 1],
      [0, 1, 4],
      [0, -1, 2],
    ];
    const result = chebyshevCenter(tall, 2, BOUND);
    expect(result).not.toBeNull();
    expect(result!.radius).toBeCloseTo(2, 6);
    expect(result!.center[0]!).toBeCloseTo(1, 6);
    expect(result!.center[1]!).toBeGreaterThanOrEqual(-1e-6);
    expect(result!.center[1]!).toBeLessThanOrEqual(2 + 1e-6);
  });

  test("the ball it reports actually fits inside", () => {
    let seed = 29;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let trial = 0; trial < 25; trial++) {
      const rows = randomRows(4 + Math.floor(rand() * 6), 2, rand);
      const result = chebyshevCenter(rows, 2, BOUND);
      expect(result).not.toBeNull();
      if (!result || result.radius <= 0) continue;
      for (const row of rows) {
        const norm = Math.hypot(row[0]!, row[1]!);
        const at = row[0]! * result.center[0]! + row[1]! * result.center[1]!;
        // the whole ball must satisfy the constraint
        expect(at + result.radius * norm).toBeLessThanOrEqual(row[2]! + 1e-6);
      }
    }
  });

  test("a negative radius flags a polyhedron with no interior", () => {
    const empty: LpRow[] = [
      [1, 0, 0],
      [-1, 0, -1],
      [0, 1, 1],
      [0, -1, 1],
    ];
    const result = chebyshevCenter(empty, 2, BOUND);
    expect(result === null || result.radius < 0).toBe(true);
  });
});
