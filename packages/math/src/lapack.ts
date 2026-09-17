export function solveDenseSystem(
  matrix: Float64Array,
  size: number,
  rhs: Float64Array,
  out: Float64Array,
  luScratch?: Float64Array,
) {
  const lu = luScratch ?? new Float64Array(size * size);
  lu.set(matrix);
  out.set(rhs);

  for (let pivot = 0; pivot < size; pivot++) {
    let pivotRow = pivot;
    let pivotValue = Math.abs(lu[pivot * size + pivot]!);
    for (let row = pivot + 1; row < size; row++) {
      const value = Math.abs(lu[row * size + pivot]!);
      if (value > pivotValue) {
        pivotValue = value;
        pivotRow = row;
      }
    }

    if (!(pivotValue > 1e-12)) {
      throw new Error("Singular linear system");
    }

    if (pivotRow !== pivot) {
      for (let col = 0; col < size; col++) {
        const a = pivot * size + col;
        const b = pivotRow * size + col;
        [lu[a], lu[b]] = [lu[b]!, lu[a]!];
      }
      [out[pivot], out[pivotRow]] = [out[pivotRow]!, out[pivot]!];
    }

    const diagonal = lu[pivot * size + pivot]!;
    for (let row = pivot + 1; row < size; row++) {
      const factorIndex = row * size + pivot;
      lu[factorIndex] = lu[factorIndex]! / diagonal;
      const factor = lu[factorIndex]!;
      for (let col = pivot + 1; col < size; col++) {
        const index = row * size + col;
        lu[index] -= factor * lu[pivot * size + col]!;
      }
    }
  }

  for (let row = 0; row < size; row++) {
    let sum = out[row]!;
    for (let col = 0; col < row; col++) {
      sum -= lu[row * size + col]! * out[col]!;
    }
    out[row] = sum;
  }

  for (let row = size - 1; row >= 0; row--) {
    let sum = out[row]!;
    for (let col = row + 1; col < size; col++) {
      sum -= lu[row * size + col]! * out[col]!;
    }
    out[row] = sum / lu[row * size + row]!;
  }

  for (let row = 0; row < size; row++) {
    if (!Number.isFinite(out[row]!)) {
      throw new Error("Singular linear system");
    }
  }

  return out;
}

export function invertDenseMatrix(
  matrix: Float64Array,
  size: number,
  out: Float64Array,
  scratch?: Float64Array,
): Float64Array {
  const work = scratch ?? new Float64Array(size * size);
  work.set(matrix);
  out.fill(0);
  for (let i = 0; i < size; i++) out[i * size + i] = 1;

  for (let pivot = 0; pivot < size; pivot++) {
    let pivotRow = pivot;
    let pivotValue = Math.abs(work[pivot * size + pivot]!);
    for (let row = pivot + 1; row < size; row++) {
      const value = Math.abs(work[row * size + pivot]!);
      if (value > pivotValue) {
        pivotValue = value;
        pivotRow = row;
      }
    }
    if (!(pivotValue > 1e-12)) {
      throw new Error("Singular linear system");
    }
    if (pivotRow !== pivot) {
      for (let col = 0; col < size; col++) {
        const a = pivot * size + col;
        const b = pivotRow * size + col;
        [work[a], work[b]] = [work[b]!, work[a]!];
        [out[a], out[b]] = [out[b]!, out[a]!];
      }
    }
    const rowOffset = pivot * size;
    const scale = 1 / work[rowOffset + pivot]!;
    for (let col = 0; col < size; col++) {
      work[rowOffset + col] *= scale;
      out[rowOffset + col] *= scale;
    }
    for (let row = 0; row < size; row++) {
      if (row === pivot) continue;
      const factor = work[row * size + pivot]!;
      if (factor === 0) continue;
      const target = row * size;
      for (let col = 0; col < size; col++) {
        work[target + col] -= factor * work[rowOffset + col]!;
        out[target + col] -= factor * out[rowOffset + col]!;
      }
    }
  }
  return out;
}
