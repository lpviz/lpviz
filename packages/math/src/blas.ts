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

/** A matrix as an iterative solver applies it: out = A v and out = Aᵀ v, however A is stored. */
export interface LinearOperator {
  rows: number;
  cols: number;
  apply(vector: Float64Array, out: Float64Array): void;
  applyTranspose(vector: Float64Array, out: Float64Array): void;
}

/** A dense matrix as an operator, its transpose kept for row dot products (see transposeMatrix). */
export function denseOperator(matrix: DenseMatrix): LinearOperator {
  const transposed = transposeMatrix(matrix);
  return {
    rows: matrix.rows,
    cols: matrix.cols,
    apply: (vector, out) => matVec(matrix, vector, out),
    applyTranspose: (vector, out) => matVec(transposed, vector, out),
  };
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

/** Row `row` of the matrix dotted with `vector`, accumulated onto `init`. */
export function rowDot(matrix: DenseMatrix, row: number, vector: ArrayLike<number>, init = 0): number {
  const { cols, data } = matrix;
  const offset = row * cols;
  let sum = init;
  for (let j = 0; j < cols; j++) sum += data[offset + j]! * vector[j]!;
  return sum;
}

/** out = Aᵀ diag(w) A (n x n, row-major), with `weight(i)` the weight of row i. */
export function weightedGram(matrix: DenseMatrix, weight: (row: number) => number, out: Float64Array): Float64Array {
  const { rows, cols, data } = matrix;
  out.fill(0);
  for (let i = 0; i < rows; i++) {
    const w = weight(i);
    const offset = i * cols;
    for (let j = 0; j < cols; j++) {
      const wj = w * data[offset + j]!;
      for (let k = 0; k < cols; k++) out[j * cols + k]! += wj * data[offset + k]!;
    }
  }
  return out;
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

/** −v. */
export const negate = (v: Float64Array): Float64Array => Float64Array.from(v, (value) => -value);

export function negateMatrix(matrix: DenseMatrix): DenseMatrix {
  return createDenseMatrix(matrix.rows, matrix.cols, negate(matrix.data));
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

/** Row `row` of the matrix copied into `out`. */
export function extractRow<T extends Float64Array | number[]>(matrix: DenseMatrix, row: number, out: T): T {
  const { cols, data } = matrix;
  const offset = row * cols;
  for (let j = 0; j < cols; j++) out[j] = data[offset + j]!;
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

/** v' M v for symmetric M; the two-variable form is kept verbatim so those results stay bit-identical. */
export function symmetricQuadraticForm(M: Float64Array, v: ArrayLike<number>, n: number): number {
  if (n === 2) {
    return M[0]! * v[0]! * v[0]! + 2 * M[1]! * v[0]! * v[1]! + M[3]! * v[1]! * v[1]!;
  }
  return quadraticForm(M, v, n);
}

/** v' M v for a symmetric n x n matrix. */
export function quadraticForm(M: Float64Array, v: ArrayLike<number>, n: number): number {
  let quadratic = 0;
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < n; k++) quadratic += M[j * n + k]! * v[j]! * v[k]!;
  }
  return quadratic;
}
