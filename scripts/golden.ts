// Golden-output harness for the whole solver path: engine → worker message
// handler → packed wire → unpack → applySolverResult → store. What reaches the
// UI (rendered header/rows/footer or blocks, error message) and the store's
// iterate/trace fields is serialized exactly (typed arrays, ±0, NaN) and hashed;
// the baseline lives in scripts/golden.json. A refactor is behavior-preserving
// on this path only if every hash is unchanged.
//
//   bun scripts/golden.ts              compare against the baseline
//   bun scripts/golden.ts --write      rewrite the baseline
//   bun scripts/golden.ts --dump DIR   also write every case's JSON into DIR
//   bun scripts/golden.ts --only TEXT  restrict to case ids containing TEXT

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Solver footers print elapsed time; pin both clocks so output is a pure
// function of the input. The worker logs expected failures (infeasible,
// unbounded) through console.error; the message itself is captured below.
performance.now = () => 0;
Date.now = () => 0;
console.error = () => {};

// The worker module registers itself on `self`; capture its handler and its
// postMessage instead of letting bun's globals see them.
type Listener = (event: { data: unknown }) => Promise<void> | void;
let workerListener: Listener | null = null;
let lastPosted: unknown = null;
(self as unknown as { addEventListener: (type: string, fn: Listener) => void }).addEventListener = (_type, fn) => {
  workerListener = fn;
};
(self as unknown as { postMessage: (msg: unknown) => void }).postMessage = (msg) => {
  lastPosted = msg;
};

await import("@/features/solver/solverWorker");
const { unpackSolverResponse } = await import("@/features/solver/resultPacking");
const { applySolverResult, formatVirtualResultRow } = await import("@/features/solver/solverService");
const store = await import("@/features/core/store");
const { deriveRegionFromPoints } = await import("@lpviz/polytope/regionAssembly");
const { ENTERING_RULES, LEAVING_RULES } = await import("@lpviz/solver-engine/simplex");
const { GALLERY_PROBLEMS, randomConvexPolygonPreview } = await import("@/features/problem-gallery/problems");
type SolverWorkerPayload = import("@/features/solver/solverWorker").SolverWorkerPayload;
type PointXY = { x: number; y: number };

if (!workerListener) throw new Error("worker did not register a message listener");

// ---------- fixtures ----------

type Fixture = { name: string; points: PointXY[]; mode: "closed" | "open"; objectives: PointXY[]; interior: PointXY };

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const centroid = (points: PointXY[]): PointXY => ({ x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length });
const rotations = (o: PointXY): PointXY[] => [o, { x: -o.y, y: o.x }, { x: -o.x, y: -o.y }];

const fixtures: Fixture[] = [];
for (const problem of GALLERY_PROBLEMS) {
  if (problem.isRandom) continue;
  fixtures.push({ name: `gallery:${problem.id}`, points: problem.vertices, mode: "closed", objectives: rotations(problem.objectiveVector), interior: problem.interiorPoint });
}
for (let seed = 1; seed <= 6; seed++) {
  const { vertices, objectiveVector } = randomConvexPolygonPreview(mulberry32(seed));
  fixtures.push({ name: `valtr:${seed}`, points: vertices, mode: "closed", objectives: [objectiveVector], interior: centroid(vertices) });
}
const square = [
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 1 },
  { x: -1, y: 1 },
];
fixtures.push({
  name: "square",
  points: square,
  mode: "closed",
  objectives: [
    { x: 1, y: 1 },
    { x: 0.3, y: -1 },
  ],
  interior: { x: 0, y: 0 },
});
fixtures.push({
  name: "degenerate-square",
  points: [
    { x: -1, y: -1 },
    { x: 0, y: -1 },
    { x: 1, y: -1 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
  ],
  mode: "closed",
  objectives: [
    { x: 1, y: 1 },
    { x: 0, y: -1 },
  ],
  interior: { x: 0, y: 0 },
});
fixtures.push({
  name: "sliver",
  points: [
    { x: -10, y: 0 },
    { x: 10, y: 0.01 },
    { x: 10, y: 0.03 },
  ],
  mode: "closed",
  objectives: [
    { x: 1, y: 0 },
    { x: -1, y: 1 },
  ],
  interior: { x: 3, y: 0.015 },
});
fixtures.push({
  name: "open-v",
  points: [
    { x: -5, y: 0 },
    { x: 0, y: -3 },
    { x: 5, y: 0 },
  ],
  mode: "open",
  objectives: [
    { x: 0, y: -1 },
    { x: 0, y: 1 },
    { x: 1, y: -1 },
  ],
  interior: { x: 0, y: 0 },
});
fixtures.push({
  name: "open-strip",
  points: [
    { x: -4, y: -2 },
    { x: 4, y: -2 },
  ],
  mode: "open",
  objectives: [
    { x: 0, y: -1 },
    { x: 1, y: 0 },
  ],
  interior: { x: 0, y: 0 },
});

// ---------- option grid (mirrors solverControls.buildRequest) ----------

type Base = { lines: ReturnType<typeof deriveRegionFromPoints>["lines"]; objective: Float64Array };

function* payloadsFor(fixture: Fixture, objective: PointXY): Generator<[string, SolverWorkerPayload]> {
  const polytope = deriveRegionFromPoints(
    fixture.points.map((p) => [p.x, p.y] as [number, number]),
    fixture.mode,
  );
  const base: Base = { lines: polytope.lines, objective: Float64Array.of(objective.x, objective.y) };
  const vertices = polytope.vertices;
  const boundingVertices = vertices.length > 0 ? vertices : fixture.points.map((p) => [p.x, p.y] as [number, number]);
  const interior = [fixture.interior.x, fixture.interior.y];
  const far = [20, 20];

  for (const dual of [false, true])
    for (const enteringRule of ENTERING_RULES)
      for (const leavingRule of LEAVING_RULES) {
        const starts: (number[] | undefined)[] = dual || vertices.length === 0 ? [undefined] : [undefined, [...vertices[0]!], [...vertices[Math.floor(vertices.length / 2)]!]];
        for (const [si, startVertex] of starts.entries())
          yield [`simplex:${dual ? "dual" : "primal"}:${enteringRule}/${leavingRule}:s${si}`, { solver: "simplex", ...base, ...(startVertex ? { startVertex } : {}), dual, enteringRule, leavingRule }];
      }

  for (const [alphaMax, correctorThreshold] of [
    [0.1, 0.9],
    [0.9, 0.5],
    [1.0, 0.9],
  ] as const)
    for (const [si, startPoint] of [undefined, interior, far].entries())
      yield [`ipm:a${alphaMax}c${correctorThreshold}:s${si}`, { solver: "ipm", ...base, ...(startPoint ? { startPoint } : {}), alphaMax, correctorThreshold, maxit: 1000 }];

  for (const ineq of [true, false])
    for (const halpern of [false, true])
      for (const colorByBasis of [false, true])
        for (const [si, startPoint] of [undefined, interior].entries())
          yield [
            `pdhg:${ineq ? "ineq" : "eq"}:${halpern ? "halpern" : "plain"}:${colorByBasis ? "basis" : "nobasis"}:s${si}`,
            { solver: "pdhg", ...base, ...(startPoint ? { startPoint } : {}), ineq, halpern, maxit: 1000, eta: 0.25, tau: 0.25, colorByBasis },
          ];
  yield ["pdhg:ineq:halpern:short", { solver: "pdhg", ...base, ineq: true, halpern: true, maxit: 30, eta: 0.25, tau: 0.25, colorByBasis: false }];
  yield ["pdhg:eq:plain:short", { solver: "pdhg", ...base, ineq: false, halpern: false, maxit: 30, eta: 0.1, tau: 0.4, colorByBasis: true }];

  for (const queryPoint of ["ellipsoid", "chebyshev", "analytic", "volumetric"] as const)
    for (const deepCuts of [true, false])
      for (const rayShoot of [true, false])
        for (const initialScale of [1.5, 3])
          yield [
            `ellipsoid:${queryPoint}:${deepCuts ? "deep" : "shallow"}:${rayShoot ? "ray" : "noray"}:x${initialScale}`,
            { solver: "ellipsoid", vertices: boundingVertices, ...base, maxit: 500, deepCuts, rayShoot, queryPoint, initialScale },
          ];
  yield ["ellipsoid:ellipsoid:short", { solver: "ellipsoid", vertices: boundingVertices, ...base, maxit: 5, deepCuts: true, rayShoot: true, queryPoint: "ellipsoid", initialScale: 1.5 }];
  yield ["ellipsoid:chebyshev:short", { solver: "ellipsoid", vertices: boundingVertices, ...base, maxit: 5, deepCuts: false, rayShoot: false, queryPoint: "chebyshev", initialScale: 1.5 }];

  for (const niter of [75, 10]) yield [`central:n${niter}`, { solver: "central", vertices, ...base, niter }];
}

// ---------- exact serialization ----------

function plain(value: unknown, depth = 0): unknown {
  if (depth > 12) return "<deep>";
  if (typeof value === "number") return Number.isFinite(value) ? (Object.is(value, -0) ? "-0" : value) : String(value);
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value === null || typeof value !== "object") return value;
  if (ArrayBuffer.isView(value)) return { [value.constructor.name]: Array.from(value as unknown as ArrayLike<number>, (n) => plain(n)) };
  if (Array.isArray(value)) return value.map((v) => plain(v, depth + 1));
  const record = value as Record<string, unknown>;
  if (typeof record.at === "function" && typeof record.length === "number") {
    // Row views are consumed only through formatVirtualResultRow (resultPresenter), so the
    // formatted text is the observable output; the row object's shape is internal.
    const rows = Array.from({ length: record.length }, (_, i) => (record.at as (i: number) => unknown)(i));
    return rows.map((r) => formatVirtualResultRow(r as never));
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const v = plain(record[key], depth + 1);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

const STORE_FIELDS = [
  "iteratePath",
  "iterateEllipsoids",
  "iterateLocalizingSets",
  "iteratePhases",
  "originalIteratePath",
  "originalIteratePhases",
  "iterateRestartIndices",
  "iterateObjectiveVector",
  "originalIterateObjectiveVector",
  "traceBuffer",
] as const;

async function runCase(id: number, payload: SolverWorkerPayload, objective: PointXY) {
  lastPosted = null;
  await workerListener!({ data: { id, ...payload } });
  const wire = lastPosted as Parameters<typeof unpackSolverResponse>[0];
  const response = unpackSolverResponse(wire);
  store.resetTraceState();
  store.setTraceCapacity(10);
  store.setState({ objectiveVector: objective, traceEnabled: true, iteratePath: { points: new Float64Array(0), count: 0, stride: 2 } });
  let rendered: unknown = null;
  if (response.success) {
    applySolverResult(response, (p: unknown) => {
      rendered = p;
    });
  }
  const state = store.getState();
  const after: Record<string, unknown> = {};
  for (const key of STORE_FIELDS) after[key] = state[key];
  // Only what reaches the UI or the store is hashed: the wire format and the unpacked
  // response are internal and free to change as long as these stay identical.
  return plain({ error: response.success ? null : response.error, rendered, after });
}

// ---------- main ----------

const args = process.argv.slice(2);
const write = args.includes("--write");
const dumpDir = args.includes("--dump") ? args[args.indexOf("--dump") + 1] : null;
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
if (dumpDir) mkdirSync(dumpDir, { recursive: true });

const baselinePath = join(import.meta.dir, "golden.json");
const hashes: Record<string, string> = {};
let id = 0;
for (const fixture of fixtures)
  for (const [oi, objective] of fixture.objectives.entries())
    for (const [key, payload] of payloadsFor(fixture, objective)) {
      const caseId = `${fixture.name}|o${oi}|${key}`;
      if (only && !caseId.includes(only)) continue;
      const json = JSON.stringify(await runCase(++id, payload, objective));
      hashes[caseId] = createHash("sha256").update(json).digest("hex").slice(0, 16);
      if (dumpDir) writeFileSync(join(dumpDir, caseId.replace(/[^A-Za-z0-9_.:|-]/g, "_") + ".json"), json);
    }

const sorted = Object.fromEntries(
  Object.keys(hashes)
    .sort()
    .map((k) => [k, hashes[k]]),
);
const total = createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
console.log(`${Object.keys(sorted).length} cases, total ${total}`);

if (write) {
  writeFileSync(baselinePath, JSON.stringify({ total, cases: sorted }, null, 2) + "\n");
  console.log(`wrote ${baselinePath}`);
} else {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as { total: string; cases: Record<string, string> };
  const changed = Object.keys(sorted).filter((k) => baseline.cases[k] !== sorted[k]);
  const missing = Object.keys(baseline.cases).filter((k) => !(k in sorted) && !only);
  for (const k of changed) console.log(`CHANGED ${k}: ${baseline.cases[k] ?? "(new)"} -> ${sorted[k]}`);
  for (const k of missing) console.log(`MISSING ${k}`);
  if (changed.length || missing.length) {
    console.log(`golden: ${changed.length} changed, ${missing.length} missing`);
    process.exit(1);
  }
  console.log("golden: all cases match");
}
