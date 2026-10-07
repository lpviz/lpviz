import { describe, expect, test } from "bun:test";
import { encodeSharedState, decodeSharedState } from "./compactUrl";
import type { SharedAppState } from "./sharedState";
import type { Vec } from "@lpviz/math/types";
import { buildConstraintRep } from "@lpviz/polytope/constraintRep";
import { simplex } from "@lpviz/solver-engine/simplex";
import { VRep } from "@lpviz/math/geometry";
import { isWellProportioned, valtrPolygon } from "@/features/problem-gallery/problems";

const MAX_OPTIMUM_ERROR = 0.001;
const ROUND_TRIPS = 10;

// Seedable LCG from solvers.test.ts
const lcg = (seed: number) => () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

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
  const { lines } = buildConstraintRep(vertices, true);
  if (lines.length === 0) return null;
  const result = simplex(lines, Float64Array.of(objective[0], objective[1]), { tol: 1e-9, dual: false });
  if (result.status !== "optimal") return null;
  const last = result.iterations[result.iterations.length - 1]!;
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

const GALLERY_PROBLEMS: SharedAppState[] = [
  {
    vertices: [
      [-8, -5],
      [-9, 4],
      [-2, 9],
      [7, 5],
      [8, -4],
    ],
    completionMode: "closed",
    objective: [7, 3],
    solverMode: "simplex",
    settings: {},
  },
  {
    vertices: [
      [0, -9],
      [-10, 0],
      [0, 9],
      [10, 0],
    ],
    completionMode: "closed",
    objective: [4, 8],
    solverMode: "simplex",
    settings: {},
  },
  {
    vertices: [
      [-12, -3],
      [-8, 5],
      [4, 6],
      [12, 1],
      [9, -5],
      [-4, -6],
    ],
    completionMode: "closed",
    objective: [9, 2],
    solverMode: "simplex",
    settings: {},
  },
  {
    vertices: [
      [-10, -6],
      [-10, 6],
      [2, 6],
      [9, 0.25],
      [9.25, -0.25],
      [2, -6],
    ],
    completionMode: "closed",
    objective: [10, 0.2],
    solverMode: "simplex",
    settings: {},
  },
  {
    vertices: [
      [-14, -4],
      [-14, 4],
      [14, 4],
      [14, -4],
    ],
    completionMode: "closed",
    objective: [3, 7],
    solverMode: "simplex",
    settings: {},
  },
  {
    vertices: [
      [-30, -0.35],
      [-30, 0.35],
      [30, 0.35],
      [30, -0.35],
    ],
    completionMode: "closed",
    objective: [10, 0.1],
    solverMode: "simplex",
    settings: {},
  },
];

describe("share link round-trip stability", () => {
  test.each(GALLERY_PROBLEMS.map((p, i) => [i, p] as const))("gallery problem #%i: optimum within tolerance and polytope convex after %i round-trips", (_index, original) => {
    if (!original.objective) throw new Error("fixture has no objective");
    const originalOptimum = bruteForceOptimum(original.vertices, original.objective);

    const final = roundTripN(original, ROUND_TRIPS);

    expect(final.vertices.length).toBe(original.vertices.length);

    // convexity
    const vrep = VRep.fromPoints(final.vertices);
    expect(vrep.isConvex()).toBe(true);

    // optimum within tolerance
    const solved = solveForOptimum(final.vertices, final.objective!);
    expect(solved).not.toBeNull();
    expect(solved!.value).toBeGreaterThanOrEqual(originalOptimum - MAX_OPTIMUM_ERROR);
    expect(solved!.value).toBeLessThanOrEqual(originalOptimum + MAX_OPTIMUM_ERROR);
  });

  test("random polygons: optimum within tolerance and polytope convex after %i round-trips", () => {
    const rand = lcg(42);
    let runs = 0;
    for (let t = 0; t < 60 && runs < 15; t++) {
      const vertices = randomConvexPolygon(rand);
      if (!vertices || vertices.length < 3) continue;
      const objective: Vec = [rand() * 4 - 2, rand() * 4 - 2];
      if (Math.abs(objective[0]) + Math.abs(objective[1]) < 0.1) continue;
      runs++;

      const original: SharedAppState = {
        vertices,
        completionMode: "closed",
        objective,
        solverMode: "simplex",
        settings: {},
      };

      const originalOptimum = bruteForceOptimum(vertices, objective);
      const final = roundTripN(original, ROUND_TRIPS);

      expect(final.vertices.length).toBe(original.vertices.length);

      const vrep = VRep.fromPoints(final.vertices);
      expect(vrep.isConvex()).toBe(true);

      const solved = solveForOptimum(final.vertices, final.objective!);
      expect(solved).not.toBeNull();
      expect(solved!.value).toBeGreaterThanOrEqual(originalOptimum - MAX_OPTIMUM_ERROR);
      expect(solved!.value).toBeLessThanOrEqual(originalOptimum + MAX_OPTIMUM_ERROR);
    }
    expect(runs).toBeGreaterThan(10);
  });

  test("each intermediate round-trip stays convex and within tolerance", () => {
    const original: SharedAppState = {
      vertices: [
        [-8, -5],
        [-9, 4],
        [-2, 9],
        [7, 5],
        [8, -4],
      ],
      completionMode: "closed",
      objective: [7, 3],
      solverMode: "simplex",
      settings: {},
    };
    const originalOptimum = bruteForceOptimum(original.vertices, original.objective!);

    let current = original;
    for (let i = 0; i < ROUND_TRIPS; i++) {
      const encoded = encodeSharedState(current);
      const decoded = decodeSharedState(encoded);
      expect(decoded).not.toBeNull();
      current = decoded!;

      expect(current.vertices.length).toBe(original.vertices.length);

      const vrep = VRep.fromPoints(current.vertices);
      expect(vrep.isConvex()).toBe(true);

      const solved = solveForOptimum(current.vertices, current.objective!);
      expect(solved).not.toBeNull();
      expect(solved!.value).toBeGreaterThanOrEqual(originalOptimum - MAX_OPTIMUM_ERROR);
      expect(solved!.value).toBeLessThanOrEqual(originalOptimum + MAX_OPTIMUM_ERROR);
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

        const original: SharedAppState = {
          vertices,
          completionMode: "closed",
          objective,
          solverMode: "simplex",
          settings: {},
        };

        const originalOptimum = bruteForceOptimum(vertices, objective);
        const final = roundTripN(original, ROUND_TRIPS);

        expect(final.vertices.length).toBe(original.vertices.length);

        const vrep = VRep.fromPoints(final.vertices);
        expect(vrep.isConvex()).toBe(true);

        const solved = solveForOptimum(final.vertices, final.objective!);
        expect(solved).not.toBeNull();
        expect(solved!.value).toBeGreaterThanOrEqual(originalOptimum - MAX_OPTIMUM_ERROR);
        expect(solved!.value).toBeLessThanOrEqual(originalOptimum + MAX_OPTIMUM_ERROR);
      }
      expect(runs).toBe(instancesPerCount);
    });
  }

  test("first round-trip locks the vertices (subsequent trips are no-ops)", () => {
    const original: SharedAppState = {
      vertices: [
        [-8, -5],
        [-9, 4],
        [-2, 9],
        [7, 5],
        [8, -4],
      ],
      completionMode: "closed",
      objective: [7, 3],
      solverMode: "simplex",
      settings: {},
    };

    const first = decodeSharedState(encodeSharedState(original))!;
    const tenth = roundTripN(original, ROUND_TRIPS);

    expect(first.vertices.length).toBe(original.vertices.length);
    expect(tenth.vertices.length).toBe(original.vertices.length);
    expect(tenth.vertices.length).toBe(first.vertices.length);
    tenth.vertices.forEach((v, i) => {
      expect(v[0]).toBeCloseTo(first.vertices[i]![0], 10);
      expect(v[1]).toBeCloseTo(first.vertices[i]![1], 10);
    });
    expect(tenth.objective![0]).toBeCloseTo(first.objective![0], 10);
    expect(tenth.objective![1]).toBeCloseTo(first.objective![1], 10);
  });
});
