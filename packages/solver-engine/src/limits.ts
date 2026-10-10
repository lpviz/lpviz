// Caps on what a run may be asked for: a share link or a hand-edited setting must not request a
// run the browser could never finish.
export const MAX_ITERATIONS = 100_000;
export const MAX_PATH_POINTS = 2 ** 10;

export function assertMaxit(maxit: number): void {
  if (maxit > MAX_ITERATIONS) throw new Error(`maxit > ${MAX_ITERATIONS} not allowed`);
}
