// What a run may be asked for: caps a share link or a hand-edited setting must respect, and the
// warm start it may carry.
export const MAX_ITERATIONS = 100_000;
export const MAX_PATH_POINTS = 2 ** 10;

export function assertMaxit(maxit: number): void {
  if (maxit > MAX_ITERATIONS) throw new Error(`maxit > ${MAX_ITERATIONS} not allowed`);
}

/** The warm start when it has one coordinate per variable; a point kept from a problem of another dimension is ignored. */
export const warmStart = (point: readonly number[] | undefined, n: number): readonly number[] | null => (point && point.length === n ? point : null);
