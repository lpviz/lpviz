import { describe, expect, test } from "bun:test";
import { createDenseMatrix, diagonalMatrix, extractColumn, hstackMatrices, identityMatrix, maxAbsDifference, negateMatrix, quadraticForm, scaleRows, transposeMatrix } from "../src/blas";

// [[1, 2, 3], [4, 5, 6]]
const M = createDenseMatrix(2, 3, Float64Array.of(1, 2, 3, 4, 5, 6));
const rows = (matrix: ReturnType<typeof createDenseMatrix>) => Array.from({ length: matrix.rows }, (_, i) => Array.from(matrix.data.subarray(i * matrix.cols, (i + 1) * matrix.cols)));

describe("dense matrix builders", () => {
  test("diagonal and identity", () => {
    expect(rows(diagonalMatrix(Float64Array.of(2, -3)))).toEqual([
      [2, 0],
      [0, -3],
    ]);
    expect(rows(identityMatrix(2))).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  test("transpose, negate and scale rows", () => {
    expect(rows(transposeMatrix(M))).toEqual([
      [1, 4],
      [2, 5],
      [3, 6],
    ]);
    expect(rows(negateMatrix(M))).toEqual([
      [-1, -2, -3],
      [-4, -5, -6],
    ]);
    expect(rows(scaleRows(M, Float64Array.of(1, -1)))).toEqual([
      [1, 2, 3],
      [-4, -5, -6],
    ]);
  });

  test("hstack places each block beside the last", () => {
    expect(rows(hstackMatrices(M, identityMatrix(2)))).toEqual([
      [1, 2, 3, 1, 0],
      [4, 5, 6, 0, 1],
    ]);
    expect(hstackMatrices().cols).toBe(0);
  });

  test("extractColumn reads one column", () => {
    expect(Array.from(extractColumn(M, 1))).toEqual([2, 5]);
  });
});

describe("vector measures", () => {
  test("maxAbsDifference is the largest entrywise gap", () => {
    expect(maxAbsDifference(Float64Array.of(1, 2, 3), Float64Array.of(1, 0, 4))).toBe(2);
    expect(maxAbsDifference(new Float64Array(0), new Float64Array(0))).toBe(0);
  });

  test("quadraticForm is v'Mv", () => {
    expect(quadraticForm(Float64Array.of(2, 1, 1, 3), [1, 2], 2)).toBe(2 + 2 * 2 + 3 * 4);
  });
});
