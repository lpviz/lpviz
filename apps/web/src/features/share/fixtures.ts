import { GALLERY_PROBLEMS } from "@/features/problem-gallery/problems";
import type { Vec } from "@lpviz/math/types";
import { expect } from "bun:test";
import type { SharedAppState } from "./sharedState";

/** A closed region with an objective, as a simplex link shares it. */
export const closed = (vertices: Vec[], objective: Vec | null, extra: Partial<SharedAppState> = {}): SharedAppState => ({
  vertices,
  completionMode: "closed",
  objective,
  solverMode: "simplex",
  settings: {},
  ...extra,
});

/** A gallery problem as it would be shared. */
export function gallery(id: string): SharedAppState {
  const problem = GALLERY_PROBLEMS.find((p) => p.id === id);
  if (!problem) throw new Error(`no gallery problem ${id}`);
  return closed(problem.vertices, problem.objectiveVector);
}

/** As many coordinates as expected, each within `digits` decimals. */
export function expectNear(actual: ArrayLike<number> | null | undefined, expected: ArrayLike<number> | null, digits = 4): void {
  if (!actual || !expected) throw new Error("expected a point");
  expect(actual.length).toBe(expected.length);
  for (let j = 0; j < expected.length; j++) expect(actual[j]).toBeCloseTo(expected[j]!, digits);
}

export function expectVerticesNear(actual: readonly Vec[], expected: readonly Vec[], digits = 4): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((vertex, i) => expectNear(actual[i], vertex, digits));
}
