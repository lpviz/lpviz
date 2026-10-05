const MAX_ITERATIONS_LIMIT = 100_000;

export function assertMaxit(maxit: number) {
  if (maxit > MAX_ITERATIONS_LIMIT) throw new Error(`maxit > ${MAX_ITERATIONS_LIMIT} not allowed`);
}

function formatMilliseconds(milliseconds: number) {
  return `${Math.round(milliseconds)}ms`;
}

/** "Converged to optimal solution in 12ms / 7 iterations", or "<stopped> after 7 iterations in 12ms". */
export function solveFooter(converged: boolean, iterationCount: number, solveTime: number, stopped = "Did not converge") {
  const elapsed = formatMilliseconds(solveTime);
  return converged ? `Converged to optimal solution in ${elapsed} / ${iterationCount} iterations` : `${stopped} after ${iterationCount} iterations in ${elapsed}`;
}
