import { centroid, signedArea } from "@lpviz/math/polygon";
import type { Vec } from "@lpviz/math/types";
import { boundsOf } from "@lpviz/math/vec";

export type GalleryProblem = {
  id: string;
  name: string;
  vertices: Vec[];
  interiorPoint: Vec;
  objectiveVector: Vec;
  isRandom?: boolean;
};

type Rng = () => number;

const RANDOM_POLYGON_MIN_VERTICES = 3;
const RANDOM_POLYGON_MAX_VERTICES = 50;
const DEFAULT_RANDOM_POLYGON_VERTICES = 10;
// Typed into the vertex prompt, asks for a random count each time
const RANDOM_VERTEX_COUNT_INPUT = "-1";
const RANDOM_POLYGON_SCALE = 24;
const RANDOM_POLYGON_MAX_TRIES = 40;
const RANDOM_POLYGON_MIN_FILL_RATIO = 0.04;
// How far a generated region is slid away from the origin, as a fraction of
// its own half-extent (see offsetFromOrigin).
const RANDOM_POLYGON_MAX_OFFSET_RATIO = 2;
const RANDOM_POLYGON_OBJECTIVE_MAGNITUDE = 7;
const RANDOM_POLYGON_OBJECTIVE_DIRECTIONS = 32;
// Thumbnail previews use few vertices: a 20-gon is a blob at 54 pixels wide,
// and the gallery item reshuffles through these while hovered, so a visibly
// different vertex count each time is part of what says "random".
const RANDOM_POLYGON_PREVIEW_MIN_VERTICES = 5;
const RANDOM_POLYGON_PREVIEW_MAX_VERTICES = 12;
const RANDOM_POLYGON_PREVIEW_SEED = 0x5eed64;

const regularPolygon = (count: number, radiusX: number, radiusY: number): Vec[] =>
  Array.from({ length: count }, (_, index) => {
    const angle = (index * 2 * Math.PI) / count;
    return [radiusX * Math.cos(angle), radiusY * Math.sin(angle)];
  });

const mulberry32 =
  (seed: number): Rng =>
  () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

const shuffle = <T>(values: T[], rng: Rng): T[] => {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [values[i], values[j]] = [values[j]!, values[i]!];
  }
  return values;
};

const randomPartition = (values: number[], rng: Rng): [number[], number[]] => {
  const plus: number[] = [];
  const minus: number[] = [];
  for (const value of values) {
    if (rng() < 0.5) plus.push(value);
    else minus.push(value);
  }
  return [plus, minus];
};

const getDeltas = (count: number, rng: Rng): number[] => {
  const sample = Array.from({ length: count }, () => rng()).sort((a, b) => a - b);
  const [plus, minus] = randomPartition(sample.slice(1, -1), rng);
  minus.reverse();
  const sequence = [sample[0]!, ...plus, sample[count - 1]!, ...minus, sample[0]!];
  const deltas: number[] = [];
  for (let i = 1; i < sequence.length; i++) {
    deltas.push(sequence[i]! - sequence[i - 1]!);
  }
  return deltas;
};

export const valtrPolygon = (count: number, rng: Rng): Vec[] => {
  const xDeltas = getDeltas(count, rng);
  const yDeltas = getDeltas(count, rng);
  shuffle(yDeltas, rng);
  const vectors = xDeltas.map((x, index): Vec => [x, yDeltas[index]!]);
  vectors.sort((a, b) => Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
  let x = 0;
  let y = 0;
  const raw: Vec[] = [[0, 0]];
  for (const vector of vectors) {
    x += vector[0];
    y += vector[1];
    raw.push([x, y]);
  }
  raw.pop();
  const minX = Math.min(...raw.map((p) => p[0]));
  const minY = Math.min(...raw.map((p) => p[1]));
  return raw.map((p) => [(p[0] - minX - 0.5) * RANDOM_POLYGON_SCALE, (p[1] - minY - 0.5) * RANDOM_POLYGON_SCALE]);
};

export const isWellProportioned = (points: Vec[]): boolean => {
  const { min, max } = boundsOf(points);
  const width = max[0]! - min[0]!;
  const height = max[1]! - min[1]!;
  if (width <= 0 || height <= 0) return false;
  return Math.abs(signedArea(points)) / (width * height) >= RANDOM_POLYGON_MIN_FILL_RATIO;
};

// Where the region sits relative to the origin matters to the solvers: IPM
// and PDHG start there, simplex leaves from there in Phase 1, and the start
// marker defaults to it — so whether the origin is inside or outside the
// region changes what a run looks like. Valtr's construction, normalized to
// its bounding box, puts the origin deep inside every polygon. Sliding the
// polygon by a random vector of up to twice its half-extent leaves the origin
// outside roughly half the time while keeping the region within a couple of
// widths of it (the gallery zooms to fit on load).
const offsetFromOrigin = (points: Vec[], rng: Rng): Vec[] => {
  const { min, max } = boundsOf(points);
  const halfWidth = (max[0]! - min[0]!) / 2;
  const halfHeight = (max[1]! - min[1]!) / 2;
  const angle = rng() * 2 * Math.PI;
  const ratio = rng() * RANDOM_POLYGON_MAX_OFFSET_RATIO;
  const dx = ratio * halfWidth * Math.cos(angle);
  const dy = ratio * halfHeight * Math.sin(angle);
  return points.map((p) => [p[0] + dx, p[1] + dy]);
};

function randomConvexPolygon(count: number, rng: Rng = Math.random): Vec[] {
  for (let attempt = 0; attempt < RANDOM_POLYGON_MAX_TRIES; attempt++) {
    const points = valtrPolygon(count, rng);
    if (isWellProportioned(points)) return offsetFromOrigin(points, rng);
  }
  return offsetFromOrigin(valtrPolygon(count, rng), rng);
}

const randomObjective = (rng: Rng): Vec => {
  const direction = Math.floor(rng() * RANDOM_POLYGON_OBJECTIVE_DIRECTIONS);
  const angle = (direction * 2 * Math.PI) / RANDOM_POLYGON_OBJECTIVE_DIRECTIONS;
  return [RANDOM_POLYGON_OBJECTIVE_MAGNITUDE * Math.cos(angle), RANDOM_POLYGON_OBJECTIVE_MAGNITUDE * Math.sin(angle)];
};

function createRandomConvexPolygonProblem(count: number, rng: Rng = Math.random): GalleryProblem {
  const vertices = randomConvexPolygon(count, rng);
  return {
    id: "random-convex-polygon",
    name: "Random",
    vertices,
    interiorPoint: centroid(vertices),
    objectiveVector: randomObjective(rng),
  };
}

const randomVertexCount = (rng: Rng): number => RANDOM_POLYGON_MIN_VERTICES + Math.floor(rng() * (RANDOM_POLYGON_MAX_VERTICES - RANDOM_POLYGON_MIN_VERTICES + 1));

// The prompt offers the previous answer as its default, so once a vertex
// count is chosen, Random Convex → Enter → Random Convex → Enter keeps
// drawing fresh regions of that size without retyping it — and remembering
// "-1" the same way keeps drawing regions of a fresh random size.
let lastVertexCountInput = String(DEFAULT_RANDOM_POLYGON_VERTICES);

/** A fresh thumbnail-sized region and objective, for the gallery item's hover reshuffle. */
export function randomConvexPolygonPreview(rng: Rng = Math.random): Pick<GalleryProblem, "vertices" | "objectiveVector"> {
  const count = RANDOM_POLYGON_PREVIEW_MIN_VERTICES + Math.floor(rng() * (RANDOM_POLYGON_PREVIEW_MAX_VERTICES - RANDOM_POLYGON_PREVIEW_MIN_VERTICES + 1));
  return { vertices: randomConvexPolygon(count, rng), objectiveVector: randomObjective(rng) };
}

export function requestRandomConvexPolygonProblem(): GalleryProblem | null {
  const input = window.prompt(`Number of vertices (${RANDOM_POLYGON_MIN_VERTICES}-${RANDOM_POLYGON_MAX_VERTICES}, or ${RANDOM_VERTEX_COUNT_INPUT} for random):`, lastVertexCountInput);
  if (input === null) return null;
  const trimmed = input.trim();
  const wantsRandomCount = trimmed === RANDOM_VERTEX_COUNT_INPUT;
  const count = wantsRandomCount ? randomVertexCount(Math.random) : Number.parseInt(trimmed, 10);
  if (count < RANDOM_POLYGON_MIN_VERTICES || count > RANDOM_POLYGON_MAX_VERTICES || (!wantsRandomCount && String(count) !== trimmed)) {
    window.alert(`Vertex count must be an integer between ${RANDOM_POLYGON_MIN_VERTICES} and ${RANDOM_POLYGON_MAX_VERTICES}, or ${RANDOM_VERTEX_COUNT_INPUT} for a random count.`);
    return null;
  }
  lastVertexCountInput = trimmed;
  return createRandomConvexPolygonProblem(count);
}

export const GALLERY_PROBLEMS: GalleryProblem[] = [
  {
    id: "pentagon",
    name: "Pentagon",
    vertices: [
      [-8, -5],
      [-9, 4],
      [-2, 9],
      [7, 5],
      [8, -4],
    ],
    interiorPoint: [-1, 1],
    objectiveVector: [7, 3],
  },
  {
    id: "corridor",
    name: "Hexagon",
    vertices: [
      [-12, -3],
      [-8, 5],
      [4, 6],
      [12, 1],
      [9, -5],
      [-4, -6],
    ],
    interiorPoint: [0, 0],
    objectiveVector: [9, 2],
  },
  {
    id: "wide-box",
    name: "Rectangle",
    vertices: [
      [-14, -4],
      [-14, 4],
      [14, 4],
      [14, -4],
    ],
    interiorPoint: [0, 0],
    objectiveVector: [3, 7],
  },
  {
    id: "needle",
    name: "Needle",
    vertices: [
      [-30, -0.35],
      [-30, 0.35],
      [30, 0.35],
      [30, -0.35],
    ],
    interiorPoint: [0, 0],
    objectiveVector: [10, 0.1],
  },
  { ...createRandomConvexPolygonProblem(DEFAULT_RANDOM_POLYGON_VERTICES, mulberry32(RANDOM_POLYGON_PREVIEW_SEED)), isRandom: true },
  {
    id: "slanted-strip",
    name: "Slanted Strip",
    vertices: [
      [-24, -8],
      [-23, -6],
      [24, 8],
      [23, 6],
    ],
    interiorPoint: [0, 0],
    objectiveVector: [8, 6],
  },
  { id: "many-facets", name: "Many Facets", vertices: regularPolygon(28, 12, 10), interiorPoint: [0, 0], objectiveVector: [5, 7] },
  { id: "flat-many", name: "Flat Facets", vertices: regularPolygon(32, 24, 2.2), interiorPoint: [0, 0], objectiveVector: [9, 1] },
  {
    id: "tight-corner",
    name: "Tight Corner",
    vertices: [
      [-10, -6],
      [-10, 6],
      [2, 6],
      [9, 0.25],
      [9.25, -0.25],
      [2, -6],
    ],
    interiorPoint: [-1, 0],
    objectiveVector: [10, 0.2],
  },
];
