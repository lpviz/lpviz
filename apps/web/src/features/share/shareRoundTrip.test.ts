import { lcg } from "@lpviz/math/random";
import { describe, expect, test } from "bun:test";
import { decodeSharedState, encodeSharedState } from "./compactUrl";
import { closed, expectNear, expectVerticesNear, gallery } from "./fixtures";
import type { SharedAppState } from "./sharedState";
import type { Vec } from "@lpviz/math/types";
import { constraintsFromChain } from "@lpviz/polytope/constraints";
import { simplex } from "@lpviz/solver-engine/simplex";
import { isConvexPolygon } from "@lpviz/math/polygon";
import { isWellProportioned, valtrPolygon } from "@/features/problem-gallery/randomPolygon";

const MAX_OPTIMUM_ERROR = 0.001;
const ROUND_TRIPS = 10;

// Random convex polygon on a circle (same approach as solvers.test.ts)
function randomConvexPolygon(rand: () => number) {
  const cnt = 3 + Math.floor(rand() * 5);
  const cx = rand() * 16 - 8;
  const cy = rand() * 16 - 8;
  const angles = Array.from({ length: cnt }, () => rand() * 2 * Math.PI).sort((a, b) => a - b);
  if (angles.some((a, i) => i > 0 && a - angles[i - 1]! < 0.2)) return null;
  const R = 1 + rand() * 8;
  return angles.map((a): Vec => [cx + R * Math.cos(a), cy + R * Math.sin(a)]);
}

// Valtr's algorithm (the gallery's) for a random convex polygon with an exact vertex count.
const MAX_TRIES = 40;

function exactVertexPolygon(vertexCount: number, rand: () => number): Vec[] {
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const pts = valtrPolygon(vertexCount, rand);
    if (isWellProportioned(pts)) return pts;
  }
  return valtrPolygon(vertexCount, rand);
}

function bruteForceOptimum(vertices: Vec[], objective: Vec): number {
  return Math.max(...vertices.map((v) => objective[0] * v[0] + objective[1] * v[1]));
}

function solveForOptimum(vertices: Vec[], objective: Vec): { value: number; x: number; y: number } | null {
  const constraints = constraintsFromChain(vertices, true);
  if (constraints.length === 0) return null;
  const result = simplex(constraints, Float64Array.of(objective[0], objective[1]), { tol: 1e-9, dual: false });
  if (result.status !== "optimal") return null;
  const { points, count, stride } = result.iterates;
  const last = points.subarray((count - 1) * stride, count * stride);
  return { value: objective[0] * last[0]! + objective[1] * last[1]!, x: last[0]!, y: last[1]! };
}

function roundTripN(state: SharedAppState, n: number): SharedAppState {
  let current = state;
  for (let i = 0; i < n; i++) {
    const encoded = encodeSharedState(current);
    const decoded = decodeSharedState(encoded);
    expect(decoded).not.toBeNull();
    current = decoded!;
  }
  return current;
}

// The shared region solves as the original did: as many vertices, still convex, and the simplex
// optimum within MAX_OPTIMUM_ERROR of the original's brute-force optimum.
function expectSolvesLike(original: SharedAppState, shared: SharedAppState) {
  const originalOptimum = bruteForceOptimum(original.vertices, original.objective!);
  expect(shared.vertices.length).toBe(original.vertices.length);
  expect(isConvexPolygon(shared.vertices)).toBe(true);
  const solved = solveForOptimum(shared.vertices, shared.objective!);
  expect(solved).not.toBeNull();
  expect(solved!.value).toBeGreaterThanOrEqual(originalOptimum - MAX_OPTIMUM_ERROR);
  expect(solved!.value).toBeLessThanOrEqual(originalOptimum + MAX_OPTIMUM_ERROR);
}

// the gallery's problems, by id so the test follows the gallery, and a diamond
const PROBLEMS: [string, SharedAppState][] = [
  ...["pentagon", "corridor", "tight-corner", "wide-box", "needle"].map((id): [string, SharedAppState] => [id, gallery(id)]),
  [
    "diamond",
    closed(
      [
        [0, -9],
        [-10, 0],
        [0, 9],
        [10, 0],
      ],
      [4, 8],
    ),
  ],
];

describe("share link round-trip stability", () => {
  test.each(PROBLEMS)("%s: optimum within tolerance and polytope convex after ten round-trips", (_name, original) => {
    expectSolvesLike(original, roundTripN(original, ROUND_TRIPS));
  });

  test("random polygons: optimum within tolerance and polytope convex after ten round-trips", () => {
    const rand = lcg(42);
    let runs = 0;
    for (let t = 0; t < 60 && runs < 15; t++) {
      const vertices = randomConvexPolygon(rand);
      if (!vertices || vertices.length < 3) continue;
      const objective: Vec = [rand() * 4 - 2, rand() * 4 - 2];
      if (Math.abs(objective[0]) + Math.abs(objective[1]) < 0.1) continue;
      runs++;
      const original = closed(vertices, objective);
      expectSolvesLike(original, roundTripN(original, ROUND_TRIPS));
    }
    expect(runs).toBeGreaterThan(10);
  });

  test("each intermediate round-trip stays convex and within tolerance", () => {
    const original = gallery("pentagon");
    let current = original;
    for (let i = 0; i < ROUND_TRIPS; i++) {
      current = roundTripN(current, 1);
      expectSolvesLike(original, current);
    }
  });

  for (const vertexCount of [10, 20, 30, 40]) {
    test(`${vertexCount}-vertex random convex polygons: optimum within tolerance and polytope convex after ${ROUND_TRIPS} round-trips`, () => {
      const instancesPerCount = 10;
      let runs = 0;
      const baseSeed = vertexCount * 1000;
      for (let t = 0; t < 60 && runs < instancesPerCount; t++) {
        const rand = lcg(baseSeed + t);
        const vertices = exactVertexPolygon(vertexCount, rand);
        if (vertices.length !== vertexCount) continue;
        const objective: Vec = [rand() * 4 - 2, rand() * 4 - 2];
        if (Math.abs(objective[0]) + Math.abs(objective[1]) < 0.1) continue;
        runs++;
        const original = closed(vertices, objective);
        expectSolvesLike(original, roundTripN(original, ROUND_TRIPS));
      }
      expect(runs).toBe(instancesPerCount);
    });
  }

  test("first round-trip locks the vertices (subsequent trips are no-ops)", () => {
    const original = gallery("pentagon");
    const first = decodeSharedState(encodeSharedState(original))!;
    const tenth = roundTripN(original, ROUND_TRIPS);
    expect(first.vertices.length).toBe(original.vertices.length);
    expectVerticesNear(tenth.vertices, first.vertices, 10);
    expectNear(tenth.objective, first.objective, 10);
  });
});
