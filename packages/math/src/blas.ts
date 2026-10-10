// Dense linear algebra over row-major Float64Array matrices.

import type { Constraint } from "./types";

/** A row-major dense matrix: entry (i, j) is data[i * cols + j]. */
export type DenseMatrix = {
  rows: number;
  cols: number;
  data: Float64Array;
};

export function createDenseMatrix(rows: number, cols: number, data?: Float64Array): DenseMatrix {
  return { rows, cols, data: data ?? new Float64Array(rows * cols) };
}

/** The constraints a·x ≤ b as the dense A and b. */
export function denseFromConstraints(constraints: readonly Constraint[]) {
  const rows = constraints.length;
  const cols = rows === 0 ? 0 : constraints[0]!.length - 1;
  const data = new Float64Array(rows * cols);
  const b = new Float64Array(rows);

  for (let i = 0; i < rows; i++) {
    const line = constraints[i]!;
    const rowOffset = i * cols;
    for (let j = 0; j < cols; j++) {
      data[rowOffset + j] = line[j]!;
    }
    b[i] = line[cols]!;
  }

  return {
    A: createDenseMatrix(rows, cols, data),
    b,
  };
}

export function infinityNorm(vector: Float64Array) {
  let maxValue = 0;
  for (let i = 0; i < vector.length; i++) {
    const absoluteValue = Math.abs(vector[i]!);
    if (absoluteValue > maxValue) {
      maxValue = absoluteValue;
    }
  }
  return maxValue;
}

export function dot(a: Float64Array, b: Float64Array) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i]! * b[i]!;
  }
  return sum;
}

export function matVec(matrix: DenseMatrix, vector: Float64Array, out: Float64Array) {
  const { rows, cols, data } = matrix;
  for (let i = 0; i < rows; i++) {
    let sum = 0;
    const rowOffset = i * cols;
    for (let j = 0; j < cols; j++) {
      sum += data[rowOffset + j]! * vector[j]!;
    }
    out[i] = sum;
  }
}

export function transposedMatVec(matrix: DenseMatrix, vector: Float64Array, out: Float64Array) {
  out.fill(0);
  const { rows, cols, data } = matrix;
  for (let i = 0; i < rows; i++) {
    const scale = vector[i]!;
    const rowOffset = i * cols;
    for (let j = 0; j < cols; j++) {
      out[j]! += data[rowOffset + j]! * scale;
    }
  }
}

export function diagonalMatrix(values: Float64Array): DenseMatrix {
  const size = values.length;
  const matrix = createDenseMatrix(size, size);
  for (let i = 0; i < size; i++) matrix.data[i * size + i] = values[i]!;
  return matrix;
}

export const identityMatrix = (size: number): DenseMatrix => diagonalMatrix(new Float64Array(size).fill(1));

export function transposeMatrix(matrix: DenseMatrix): DenseMatrix {
  const out = createDenseMatrix(matrix.cols, matrix.rows);
  for (let row = 0; row < matrix.rows; row++) {
    const rowOffset = row * matrix.cols;
    for (let col = 0; col < matrix.cols; col++) {
      out.data[col * matrix.rows + row] = matrix.data[rowOffset + col]!;
    }
  }
  return out;
}

export function negateMatrix(matrix: DenseMatrix): DenseMatrix {
  return createDenseMatrix(
    matrix.rows,
    matrix.cols,
    Float64Array.from(matrix.data, (value) => -value),
  );
}

export function scaleRows(matrix: DenseMatrix, rowScales: Float64Array): DenseMatrix {
  const out = createDenseMatrix(matrix.rows, matrix.cols);
  for (let row = 0; row < matrix.rows; row++) {
    const scale = rowScales[row]!;
    const rowOffset = row * matrix.cols;
    for (let col = 0; col < matrix.cols; col++) {
      out.data[rowOffset + col] = matrix.data[rowOffset + col]! * scale;
    }
  }
  return out;
}

/** The matrices side by side; they share a row count. */
export function hstackMatrices(...matrices: DenseMatrix[]): DenseMatrix {
  if (matrices.length === 0) return createDenseMatrix(0, 0);
  const rows = matrices[0]!.rows;
  const cols = matrices.reduce((sum, matrix) => sum + matrix.cols, 0);
  const out = createDenseMatrix(rows, cols);
  let colOffset = 0;
  for (const matrix of matrices) {
    for (let row = 0; row < rows; row++) {
      const srcOffset = row * matrix.cols;
      const dstOffset = row * cols + colOffset;
      for (let col = 0; col < matrix.cols; col++) {
        out.data[dstOffset + col] = matrix.data[srcOffset + col]!;
      }
    }
    colOffset += matrix.cols;
  }
  return out;
}

export function extractColumn(matrix: DenseMatrix, column: number, out: Float64Array): Float64Array {
  for (let row = 0; row < matrix.rows; row++) {
    out[row] = matrix.data[row * matrix.cols + column]!;
  }
  return out;
}

/** The largest |a_i − b_i|. */
export function maxAbsDifference(a: Float64Array, b: Float64Array): number {
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    const delta = Math.abs(b[i]! - a[i]!);
    if (delta > worst) worst = delta;
  }
  return worst;
}

/** v' M v for a symmetric n x n matrix. */
export function quadraticForm(M: Float64Array, v: ArrayLike<number>, n: number): number {
  let quadratic = 0;
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < n; k++) quadratic += M[j * n + k]! * v[j]! * v[k]!;
  }
  return quadratic;
}
