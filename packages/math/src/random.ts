// Seeded generators of uniform numbers in [0, 1), for reproducible shapes and tests: one seed, one sequence.

export type Rng = () => number;

/** mulberry32, a 32-bit generator good enough for shapes and shuffles. */
export const mulberry32 =
  (seed: number): Rng =>
  () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

/** The classic 2^31 linear congruential generator, which the test fixtures draw from. */
export const lcg =
  (seed: number): Rng =>
  () =>
    (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
