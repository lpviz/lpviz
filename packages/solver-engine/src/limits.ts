// What a run may be asked for: caps a share link or a hand-edited setting must respect, and the
// warm start it may carry.
export const MAX_ITERATIONS = 100_000;
export const MAX_PATH_POINTS = 2 ** 10;

/** The run asks for more of `name` than `cap` allows. */
export function assertAtMost(name: string, value: number, cap: number): void {
  if (value > cap) throw new Error(`${name} > ${cap} not allowed`);
}

/** The warm start when it has one coordinate per variable; a point kept from a problem of another dimension is ignored. */
export const warmStart = (point: readonly number[] | undefined, n: number): readonly number[] | null => (point && point.length === n ? point : null);
