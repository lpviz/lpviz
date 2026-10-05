import { describe, expect, test } from "bun:test";
import { encodeSharedState, decodeSharedState } from "./compactUrl";
import type { SharedAppState } from "./sharedState";
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
  return angles.map((a) => ({
    x: cx + R * Math.cos(a),
    y: cy + R * Math.sin(a),
  }));
}

// Valtr's algorithm (the gallery's) for a random convex polygon with an exact vertex count.
const MAX_TRIES = 40;

function exactVertexPolygon(vertexCount: number, rand: () => number): { x: number; y: number }[] {
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const pts = valtrPolygon(vertexCount, rand);
    if (isWellProportioned(pts)) return pts;
  }
  return valtrPolygon(vertexCount, rand);
}

function bruteForceOptimum(vertices: { x: number; y: number }[], objective: { x: number; y: number }): number {
  return Math.max(...vertices.map((v) => objective.x * v.x + objective.y * v.y));
}

function solveForOptimum(vertices: { x: number; y: number }[], objective: { x: number; y: number }): { value: number; x: number; y: number } | null {
  const { lines } = buildConstraintRep(
    vertices.map((v) => [v.x, v.y]),
    true,
  );
  if (lines.length === 0) return null;
  const result = simplex(lines, Float64Array.of(objective.x, objective.y), { tol: 1e-9, dual: false });
  if (result.status !== "optimal") return null;
  const last = result.iterations[result.iterations.length - 1]!;
  return { value: objective.x * last[0]! + objective.y * last[1]!, x: last[0]!, y: last[1]! };
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
      { x: -8, y: -5 },
      { x: -9, y: 4 },
      { x: -2, y: 9 },
      { x: 7, y: 5 },
      { x: 8, y: -4 },
    ],
    completionMode: "closed",
    objective: { x: 7, y: 3 },
    solverMode: "simplex",
    settings: {},
  },
  {
    vertices: [
      { x: 0, y: -9 },
      { x: -10, y: 0 },
      { x: 0, y: 9 },
      { x: 10, y: 0 },
    ],
    completionMode: "closed",
    objective: { x: 4, y: 8 },
    solverMode: "simplex",
    settings: {},
  },
  {
    vertices: [
      { x: -12, y: -3 },
      { x: -8, y: 5 },
      { x: 4, y: 6 },
      { x: 12, y: 1 },
      { x: 9, y: -5 },
      { x: -4, y: -6 },
    ],
    completionMode: "closed",
    objective: { x: 9, y: 2 },
    solverMode: "simplex",
    settings: {},
  },
  {
    vertices: [
      { x: -10, y: -6 },
      { x: -10, y: 6 },
      { x: 2, y: 6 },
      { x: 9, y: 0.25 },
      { x: 9.25, y: -0.25 },
      { x: 2, y: -6 },
    ],
    completionMode: "closed",
    objective: { x: 10, y: 0.2 },
    solverMode: "simplex",
    settings: {},
  },
  {
    vertices: [
      { x: -14, y: -4 },
      { x: -14, y: 4 },
      { x: 14, y: 4 },
      { x: 14, y: -4 },
    ],
    completionMode: "closed",
    objective: { x: 3, y: 7 },
    solverMode: "simplex",
    settings: {},
  },
  {
    vertices: [
      { x: -30, y: -0.35 },
      { x: -30, y: 0.35 },
      { x: 30, y: 0.35 },
      { x: 30, y: -0.35 },
    ],
    completionMode: "closed",
    objective: { x: 10, y: 0.1 },
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
      const objective = { x: rand() * 4 - 2, y: rand() * 4 - 2 };
      if (Math.abs(objective.x) + Math.abs(objective.y) < 0.1) continue;
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
        { x: -8, y: -5 },
        { x: -9, y: 4 },
        { x: -2, y: 9 },
        { x: 7, y: 5 },
        { x: 8, y: -4 },
      ],
      completionMode: "closed",
      objective: { x: 7, y: 3 },
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
        const objective = { x: rand() * 4 - 2, y: rand() * 4 - 2 };
        if (Math.abs(objective.x) + Math.abs(objective.y) < 0.1) continue;
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
        { x: -8, y: -5 },
        { x: -9, y: 4 },
        { x: -2, y: 9 },
        { x: 7, y: 5 },
        { x: 8, y: -4 },
      ],
      completionMode: "closed",
      objective: { x: 7, y: 3 },
      solverMode: "simplex",
      settings: {},
    };

    const first = decodeSharedState(encodeSharedState(original))!;
    const tenth = roundTripN(original, ROUND_TRIPS);

    expect(first.vertices.length).toBe(original.vertices.length);
    expect(tenth.vertices.length).toBe(original.vertices.length);
    expect(tenth.vertices.length).toBe(first.vertices.length);
    tenth.vertices.forEach((v, i) => {
      expect(v.x).toBeCloseTo(first.vertices[i]!.x, 10);
      expect(v.y).toBeCloseTo(first.vertices[i]!.y, 10);
    });
    expect(tenth.objective!.x).toBeCloseTo(first.objective!.x, 10);
    expect(tenth.objective!.y).toBeCloseTo(first.objective!.y, 10);
  });
});
