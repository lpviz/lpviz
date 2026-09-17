import { describe, expect, test } from "bun:test";
import { invertDenseMatrix, solveDenseSystem } from "../src/lapack";

const solve = (matrix: number[], rhs: number[]) => {
  const size = Math.sqrt(matrix.length);
  return Array.from(
    solveDenseSystem(
      Float64Array.from(matrix),
      size,
      Float64Array.from(rhs),
      new Float64Array(size),
    ),
  );
};

describe("solveDenseSystem", () => {
  test("solves a well-conditioned system", () => {
    const [x, y] = solve([2, 1, 1, 3], [3, 5]);
    expect(x).toBeCloseTo(0.8, 12);
    expect(y).toBeCloseTo(1.4, 12);
  });

  test("pivots when the diagonal is zero", () => {
    expect(solve([0, 1, 1, 0], [2, 3])).toEqual([3, 2]);
  });

  test("throws on a singular system", () => {
    expect(() => solve([1, 2, 2, 4], [1, 2])).toThrow("Singular linear system");
  });

  test("throws when NaN sits in a pivot position", () => {
    expect(() => solve([NaN, 1, 0, 1], [1, 1])).toThrow(
      "Singular linear system",
    );
  });

  test("throws when NaN sits off-pivot with finite pivots", () => {
    expect(() => solve([1, NaN, 0, 1], [1, 1])).toThrow(
      "Singular linear system",
    );
  });
});

describe("invertDenseMatrix", () => {
  const invert = (matrix: number[]) => {
    const size = Math.sqrt(matrix.length);
    return Array.from(
      invertDenseMatrix(Float64Array.from(matrix), size, new Float64Array(size * size)),
    );
  };

  test("inverts a matrix that needs a row swap", () => {
    // [0 1; 1 0] is its own inverse and has a zero on the first diagonal
    expect(invert([0, 1, 1, 0])).toEqual([0, 1, 1, 0]);
  });

  test("agrees with the linear solver", () => {
    const matrix = [4, 1, 2, 1, 3, 0, 2, 0, 5];
    const inverse = invert(matrix);
    for (let column = 0; column < 3; column++) {
      const unit = [0, 0, 0];
      unit[column] = 1;
      const solved = solveDenseSystem(
        Float64Array.from(matrix),
        3,
        Float64Array.from(unit),
        new Float64Array(3),
      );
      for (let row = 0; row < 3; row++) {
        expect(inverse[row * 3 + column]!).toBeCloseTo(solved[row]!, 12);
      }
    }
  });

  test("throws on a singular matrix", () => {
    expect(() => invert([1, 2, 2, 4])).toThrow("Singular linear system");
  });
});
