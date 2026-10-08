// The row at or below `pivot` holding the largest |entry| of column `pivot`.
// `!(x > 1e-12)` rather than `x <= 1e-12` so a NaN pivot is rejected too.
function findPivotRow(lu: Float64Array, size: number, pivot: number): number {
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
  return pivotRow;
}

export function solveDenseSystem(matrix: Float64Array, size: number, rhs: Float64Array, out: Float64Array, luScratch?: Float64Array) {
  const lu = luScratch ?? new Float64Array(size * size);
  lu.set(matrix);
  out.set(rhs);

  for (let pivot = 0; pivot < size; pivot++) {
    const pivotRow = findPivotRow(lu, size, pivot);
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
      const factor = lu[factorIndex];
      for (let col = pivot + 1; col < size; col++) {
        const index = row * size + col;
        lu[index]! -= factor * lu[pivot * size + col]!;
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

export function invertDenseMatrix(matrix: Float64Array, size: number, out: Float64Array, scratch?: Float64Array): Float64Array {
  const work = scratch ?? new Float64Array(size * size);
  work.set(matrix);
  out.fill(0);
  for (let i = 0; i < size; i++) out[i * size + i] = 1;

  for (let pivot = 0; pivot < size; pivot++) {
    const pivotRow = findPivotRow(work, size, pivot);
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
      work[rowOffset + col]! *= scale;
      out[rowOffset + col]! *= scale;
    }
    for (let row = 0; row < size; row++) {
      if (row === pivot) continue;
      const factor = work[row * size + pivot]!;
      if (factor === 0) continue;
      const target = row * size;
      for (let col = 0; col < size; col++) {
        work[target + col]! -= factor * work[rowOffset + col]!;
        out[target + col]! -= factor * out[rowOffset + col]!;
      }
    }
  }
  return out;
}

/**
 * The lower Cholesky factor L (L Lᵀ = H) of a symmetric matrix, or null when it is not numerically
 * positive definite — which is also the positive-definiteness test every caller needs before
 * trusting an inverse or a log-determinant.
 */
export function cholesky(H: Float64Array, size: number): Float64Array | null {
  const L = new Float64Array(size * size);
  for (let j = 0; j < size; j++) {
    let diagonal = H[j * size + j]!;
    for (let k = 0; k < j; k++) diagonal -= L[j * size + k]! * L[j * size + k]!;
    if (!(diagonal > 0) || !Number.isFinite(diagonal)) return null;
    const ljj = Math.sqrt(diagonal);
    L[j * size + j] = ljj;
    for (let i = j + 1; i < size; i++) {
      let sum = H[i * size + j]!;
      for (let k = 0; k < j; k++) sum -= L[i * size + k]! * L[j * size + k]!;
      L[i * size + j] = sum / ljj;
    }
  }
  return L;
}

/** log det (L Lᵀ) from a Cholesky factor, or null when it is not finite. */
export function logDetFromCholesky(L: Float64Array, size: number): number | null {
  let logDet = 0;
  for (let j = 0; j < size; j++) logDet += 2 * Math.log(L[j * size + j]!);
  return Number.isFinite(logDet) ? logDet : null;
}

/** (L Lᵀ)⁻¹ from a Cholesky factor, by a forward and a back substitution per unit column. */
export function invertFromCholesky(L: Float64Array, size: number): Float64Array {
  const inverse = new Float64Array(size * size);
  const column = new Float64Array(size);
  for (let k = 0; k < size; k++) {
    // forward: L y = e_k
    for (let i = 0; i < size; i++) {
      let sum = i === k ? 1 : 0;
      for (let j = 0; j < i; j++) sum -= L[i * size + j]! * column[j]!;
      column[i] = sum / L[i * size + i]!;
    }
    // back: Lᵀ x = y
    for (let i = size - 1; i >= 0; i--) {
      let sum = column[i]!;
      for (let j = i + 1; j < size; j++) sum -= L[j * size + i]! * column[j]!;
      column[i] = sum / L[i * size + i]!;
    }
    for (let i = 0; i < size; i++) inverse[i * size + k] = column[i]!;
  }
  return inverse;
}
