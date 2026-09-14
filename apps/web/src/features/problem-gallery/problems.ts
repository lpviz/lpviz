import { signedArea, VRep } from "@lpviz/math/geometry";
import type { PointXY } from "@lpviz/math/types";

export type GalleryProblem = {
  id: string;
  name: string;
  vertices: PointXY[];
  interiorPoint: PointXY;
  objectiveVector: PointXY;
  isRandom?: boolean;
};

type Rng = () => number;

const RANDOM_POLYGON_MIN_VERTICES = 4;
const RANDOM_POLYGON_MAX_VERTICES = 40;
const DEFAULT_RANDOM_POLYGON_VERTICES = 20;
const RANDOM_POLYGON_SCALE = 24;
const RANDOM_POLYGON_MAX_TRIES = 40;
const RANDOM_POLYGON_MIN_FILL_RATIO = 0.04;
const RANDOM_POLYGON_OBJECTIVE_MAGNITUDE = 7;
const RANDOM_POLYGON_OBJECTIVE_DIRECTIONS = 32;
const RANDOM_POLYGON_PREVIEW_SEED = 0x5eed65;

const regularPolygon = (count: number, radiusX: number, radiusY: number) =>
  Array.from({ length: count }, (_, index) => {
    const angle = (index * 2 * Math.PI) / count;
    return {
      x: radiusX * Math.cos(angle),
      y: radiusY * Math.sin(angle),
    };
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
    [values[i], values[j]] = [values[j], values[i]];
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
  const sequence = [sample[0], ...plus, sample[count - 1], ...minus, sample[0]];
  const deltas: number[] = [];
  for (let i = 1; i < sequence.length; i++) {
    deltas.push(sequence[i] - sequence[i - 1]);
  }
  return deltas;
};

const valtrPolygon = (count: number, rng: Rng): PointXY[] => {
  const xDeltas = getDeltas(count, rng);
  const yDeltas = getDeltas(count, rng);
  shuffle(yDeltas, rng);
  const vectors = xDeltas.map((x, index) => ({ x, y: yDeltas[index] }));
  vectors.sort((a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));
  let x = 0;
  let y = 0;
  const raw = [{ x: 0, y: 0 }];
  for (const vector of vectors) {
    x += vector.x;
    y += vector.y;
    raw.push({ x, y });
  }
  raw.pop();
  const minX = Math.min(...raw.map((p) => p.x));
  const minY = Math.min(...raw.map((p) => p.y));
  return raw.map((p) => ({
    x: (p.x - minX - 0.5) * RANDOM_POLYGON_SCALE,
    y: (p.y - minY - 0.5) * RANDOM_POLYGON_SCALE,
  }));
};

const isWellProportioned = (points: PointXY[]): boolean => {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = maxX - minX;
  const height = maxY - minY;
  if (width <= 0 || height <= 0) return false;
  return Math.abs(signedArea(points)) / (width * height) >= RANDOM_POLYGON_MIN_FILL_RATIO;
};

function randomConvexPolygon(count: number, rng: Rng = Math.random): PointXY[] {
  for (let attempt = 0; attempt < RANDOM_POLYGON_MAX_TRIES; attempt++) {
    const points = valtrPolygon(count, rng);
    if (isWellProportioned(points)) return points;
  }
  return valtrPolygon(count, rng);
}

const randomObjective = (rng: Rng): PointXY => {
  const direction = Math.floor(rng() * RANDOM_POLYGON_OBJECTIVE_DIRECTIONS);
  const angle = (direction * 2 * Math.PI) / RANDOM_POLYGON_OBJECTIVE_DIRECTIONS;
  return {
    x: RANDOM_POLYGON_OBJECTIVE_MAGNITUDE * Math.cos(angle),
    y: RANDOM_POLYGON_OBJECTIVE_MAGNITUDE * Math.sin(angle),
  };
};

const convexCentroid = (points: PointXY[]): PointXY => VRep.fromPoints(points).centroidPoint();

function createRandomConvexPolygonProblem(count: number, rng: Rng = Math.random): GalleryProblem {
  const vertices = randomConvexPolygon(count, rng);
  return {
    id: "random-convex-polygon",
    name: "Random Convex",
    vertices,
    interiorPoint: convexCentroid(vertices),
    objectiveVector: randomObjective(rng),
  };
}

export function requestRandomConvexPolygonProblem(): GalleryProblem | null {
  const input = window.prompt(`Number of vertices (${RANDOM_POLYGON_MIN_VERTICES}-${RANDOM_POLYGON_MAX_VERTICES}):`, String(DEFAULT_RANDOM_POLYGON_VERTICES));
  if (input === null) return null;
  const count = Number.parseInt(input, 10);
  if (count < RANDOM_POLYGON_MIN_VERTICES || count > RANDOM_POLYGON_MAX_VERTICES || String(count) !== input.trim()) {
    window.alert(`Vertex count must be an integer between ${RANDOM_POLYGON_MIN_VERTICES} and ${RANDOM_POLYGON_MAX_VERTICES}.`);
    return null;
  }
  return createRandomConvexPolygonProblem(count);
}

export const GALLERY_PROBLEMS: GalleryProblem[] = [
  {
    id: "pentagon",
    name: "Pentagon",
    vertices: [
      { x: -8, y: -5 },
      { x: -9, y: 4 },
      { x: -2, y: 9 },
      { x: 7, y: 5 },
      { x: 8, y: -4 },
    ],
    interiorPoint: { x: -1, y: 1 },
    objectiveVector: { x: 7, y: 3 },
  },
  {
    id: "corridor",
    name: "Corridor",
    vertices: [
      { x: -12, y: -3 },
      { x: -8, y: 5 },
      { x: 4, y: 6 },
      { x: 12, y: 1 },
      { x: 9, y: -5 },
      { x: -4, y: -6 },
    ],
    interiorPoint: { x: 0, y: 0 },
    objectiveVector: { x: 9, y: 2 },
  },
  {
    id: "diamond",
    name: "Diamond",
    vertices: [
      { x: 0, y: -9 },
      { x: -10, y: 0 },
      { x: 0, y: 9 },
      { x: 10, y: 0 },
    ],
    interiorPoint: { x: 0, y: 0 },
    objectiveVector: { x: 4, y: 8 },
  },
  {
    id: "wide-box",
    name: "Wide Box",
    vertices: [
      { x: -14, y: -4 },
      { x: -14, y: 4 },
      { x: 14, y: 4 },
      { x: 14, y: -4 },
    ],
    interiorPoint: { x: 0, y: 0 },
    objectiveVector: { x: 3, y: 7 },
  },
  {
    id: "needle",
    name: "Needle",
    vertices: [
      { x: -30, y: -0.35 },
      { x: -30, y: 0.35 },
      { x: 30, y: 0.35 },
      { x: 30, y: -0.35 },
    ],
    interiorPoint: { x: 0, y: 0 },
    objectiveVector: { x: 10, y: 0.1 },
  },
  {
    id: "slanted-strip",
    name: "Slanted Strip",
    vertices: [
      { x: -24, y: -8 },
      { x: -23, y: -6 },
      { x: 24, y: 8 },
      { x: 23, y: 6 },
    ],
    interiorPoint: { x: 0, y: 0 },
    objectiveVector: { x: 8, y: 6 },
  },
  {
    id: "many-facets",
    name: "Many Facets",
    vertices: regularPolygon(28, 12, 10),
    interiorPoint: { x: 0, y: 0 },
    objectiveVector: { x: 5, y: 7 },
  },
  {
    id: "flat-many",
    name: "Flat Facets",
    vertices: regularPolygon(32, 24, 2.2),
    interiorPoint: { x: 0, y: 0 },
    objectiveVector: { x: 9, y: 1 },
  },
  {
    id: "tight-corner",
    name: "Tight Corner",
    vertices: [
      { x: -10, y: -6 },
      { x: -10, y: 6 },
      { x: 2, y: 6 },
      { x: 9, y: 0.25 },
      { x: 9.25, y: -0.25 },
      { x: 2, y: -6 },
    ],
    interiorPoint: { x: -1, y: 0 },
    objectiveVector: { x: 10, y: 0.2 },
  },
  {
    ...createRandomConvexPolygonProblem(DEFAULT_RANDOM_POLYGON_VERTICES, mulberry32(RANDOM_POLYGON_PREVIEW_SEED)),
    isRandom: true,
  },
];
