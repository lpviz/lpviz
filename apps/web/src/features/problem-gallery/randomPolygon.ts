// Random convex regions: Valtr's construction scaled to the canvas, proportioned, slid off the
// origin, with an objective to go with them. Pure in the generator it is given, so the gallery's
// seeded entry, the thumbnails' reshuffle and the tests draw from the same source.

import { signedArea } from "@lpviz/math/polygon";
import type { Rng } from "@lpviz/math/random";
import type { Vec } from "@lpviz/math/types";
import { boundsOf } from "@lpviz/math/vec";

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

/** A random convex polygon of `count` vertices, slid off the origin (see offsetFromOrigin). */
export function randomConvexPolygon(count: number, rng: Rng = Math.random): Vec[] {
  for (let attempt = 0; attempt < RANDOM_POLYGON_MAX_TRIES; attempt++) {
    const points = valtrPolygon(count, rng);
    if (isWellProportioned(points)) return offsetFromOrigin(points, rng);
  }
  return offsetFromOrigin(valtrPolygon(count, rng), rng);
}

/** An objective of fixed magnitude in one of a few directions. */
export const randomObjective = (rng: Rng): Vec => {
  const direction = Math.floor(rng() * RANDOM_POLYGON_OBJECTIVE_DIRECTIONS);
  const angle = (direction * 2 * Math.PI) / RANDOM_POLYGON_OBJECTIVE_DIRECTIONS;
  return [RANDOM_POLYGON_OBJECTIVE_MAGNITUDE * Math.cos(angle), RANDOM_POLYGON_OBJECTIVE_MAGNITUDE * Math.sin(angle)];
};

/** A fresh thumbnail-sized region and objective, for the gallery item's hover reshuffle. */
export function randomConvexPolygonPreview(rng: Rng = Math.random): { vertices: Vec[]; objectiveVector: Vec } {
  const count = RANDOM_POLYGON_PREVIEW_MIN_VERTICES + Math.floor(rng() * (RANDOM_POLYGON_PREVIEW_MAX_VERTICES - RANDOM_POLYGON_PREVIEW_MIN_VERTICES + 1));
  return { vertices: randomConvexPolygon(count, rng), objectiveVector: randomObjective(rng) };
}
