import { centroid } from "@lpviz/math/polygon";
import { mulberry32, type Rng } from "@lpviz/math/random";
import type { Vec } from "@lpviz/math/types";
import { randomConvexPolygon, randomObjective } from "./randomPolygon";

export type GalleryProblem = {
  id: string;
  name: string;
  vertices: Vec[];
  interiorPoint: Vec;
  objectiveVector: Vec;
  isRandom?: boolean;
};

const RANDOM_POLYGON_MIN_VERTICES = 3;
const RANDOM_POLYGON_MAX_VERTICES = 50;
const DEFAULT_RANDOM_POLYGON_VERTICES = 10;
// Typed into the vertex prompt, asks for a random count each time
const RANDOM_VERTEX_COUNT_INPUT = "-1";
const RANDOM_POLYGON_PREVIEW_SEED = 0x5eed64;

const regularPolygon = (count: number, radiusX: number, radiusY: number): Vec[] =>
  Array.from({ length: count }, (_, index) => {
    const angle = (index * 2 * Math.PI) / count;
    return [radiusX * Math.cos(angle), radiusY * Math.sin(angle)];
  });

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
