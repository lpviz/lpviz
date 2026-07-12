import type { LinesND } from "./types";

export type DenseMatrix = {
  rows: number;
  cols: number;
  data: Float64Array;
};

export function createDenseMatrix(rows: number, cols: number, data?: Float64Array): DenseMatrix {
  return { rows, cols, data: data ?? new Float64Array(rows * cols) };
}

export function linesToDenseAb(lines: LinesND) {
  const rows = lines.length;
  const cols = rows === 0 ? 0 : lines[0]!.length - 1;
  const data = new Float64Array(rows * cols);
  const b = new Float64Array(rows);

  for (let i = 0; i < rows; i++) {
    const line = lines[i]!;
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
      out[j] += data[rowOffset + j]! * scale;
    }
  }
}
