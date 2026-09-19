import { describe, expect, test } from "bun:test";
import { encodeSharedState, decodeSharedState } from "./compactUrl";
import type { SharedAppState } from "./sharedState";
import { buildConstraintRep } from "@lpviz/polytope/constraintRep";
import { simplex } from "@lpviz/solver-engine/simplex";
import { VRep } from "@lpviz/math/geometry";

const MAX_OPTIMUM_ERROR = 0.001;
const ROUND_TRIPS = 10;

// Seedable LCG from solvers.test.ts
const lcg = (seed: number) => () =>
  (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

// Random convex polygon on a circle (same approach as solvers.test.ts)
function randomConvexPolygon(rand: () => number) {
  const cnt = 3 + Math.floor(rand() * 5);
  const cx = rand() * 16 - 8;
  const cy = rand() * 16 - 8;
  const angles = Array.from({ length: cnt }, () => rand() * 2 * Math.PI).sort(
    (a, b) => a - b,
  );
  if (angles.some((a, i) => i > 0 && a - angles[i - 1]! < 0.2)) return null;
  const R = 1 + rand() * 8;
  return angles.map(
    (a) =>
      ({
        x: cx + R * Math.cos(a),
        y: cy + R * Math.sin(a),
      }) as { x: number; y: number },
  );
}

// Valtr's algorithm for a random convex polygon with an exact vertex count.
// Mirrors the gallery implementation in problems.ts.
const SCALE = 24;
const MAX_TRIES = 40;
const MIN_FILL = 0.04;

function getDeltas(count: number, rand: () => number): number[] {
  const sample = Array.from({ length: count }, () => rand()).sort(
    (a, b) => a - b,
  );
  const plus: number[] = [];
  const minus: number[] = [];
  for (let i = 1; i < sample.length - 1; i++) {
    if (rand() < 0.5) plus.push(sample[i]!);
    else minus.push(sample[i]!);
  }
  minus.reverse();
  const sequence = [sample[0], ...plus, sample[sample.length - 1]!, ...minus, sample[0]!];
  const deltas: number[] = [];
  for (let i = 1; i < sequence.length; i++) {
    deltas.push(sequence[i]! - sequence[i - 1]!);
  }
  return deltas;
}

function valtrPolygon(
  count: number,
  rand: () => number,
): { x: number; y: number }[] {
  const xDeltas = getDeltas(count, rand);
  const yDeltas = getDeltas(count, rand);
  // shuffle yDeltas
  for (let i = yDeltas.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [yDeltas[i], yDeltas[j]] = [yDeltas[j]!, yDeltas[i]!];
  }
  const vectors = xDeltas.map((x, i) => ({ x, y: yDeltas[i]! }));
  vectors.sort(
    (a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x),
  );
  let x = 0;
  let y = 0;
  const raw = [{ x: 0, y: 0 }];
  for (const v of vectors) {
    x += v.x;
    y += v.y;
    raw.push({ x, y });
  }
  raw.pop();
  const minX = Math.min(...raw.map((p) => p.x));
  const minY = Math.min(...raw.map((p) => p.y));
  return raw.map((p) => ({
    x: (p.x - minX - 0.5) * SCALE,
    y: (p.y - minY - 0.5) * SCALE,
  }));
}

function isWellProportioned(points: { x: number; y: number }[]): boolean {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  if (w <= 0 || h <= 0) return false;
  // signed area via shoelace
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const cur = points[i]!;
    const next = points[(i + 1) % points.length]!;
    area += cur.x * next.y - next.x * cur.y;
  }
  return Math.abs(area / 2) / (w * h) >= MIN_FILL;
}

function exactVertexPolygon(
  vertexCount: number,
  rand: () => number,
): { x: number; y: number }[] {
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const pts = valtrPolygon(vertexCount, rand);
    if (isWellProportioned(pts)) return pts;
  }
  return valtrPolygon(vertexCount, rand);
}

function bruteForceOptimum(
  vertices: { x: number; y: number }[],
  objective: { x: number; y: number },
): number {
  return Math.max(
    ...vertices.map((v) => objective.x * v.x + objective.y * v.y),
  );
}

function solveForOptimum(
  vertices: { x: number; y: number }[],
  objective: { x: number; y: number },
): { value: number; x: number; y: number } | null {
  const { lines } = buildConstraintRep(
    vertices.map((v) => [v.x, v.y]),
    true,
  );
  if (lines.length === 0) return null;
  const result = simplex(
    lines,
    Float64Array.of(objective.x, objective.y),
    { tol: 1e-9, verbose: false, dual: false },
  );
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
  test.each(GALLERY_PROBLEMS.map((p, i) => [i, p] as const))(
    "gallery problem #%i: optimum within tolerance and polytope convex after %i round-trips",
    (_index, original) => {
      const originalOptimum = bruteForceOptimum(
        original.vertices,
        original.objective!,
      );

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
    },
  );

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
    const originalOptimum = bruteForceOptimum(
      original.vertices,
      original.objective!,
    );

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
        expect(solved!.value).toBeGreaterThanOrEqual(
          originalOptimum - MAX_OPTIMUM_ERROR,
        );
        expect(solved!.value).toBeLessThanOrEqual(
          originalOptimum + MAX_OPTIMUM_ERROR,
        );
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
