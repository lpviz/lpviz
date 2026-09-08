import type { CompletionMode, SolverMode, State } from "@/features/core/store";

export type ShareSettings = {
  alphaMax?: number;
  correctorThreshold?: number;
  maxitIPM?: number;
  simplexDualMode?: boolean;
  simplexEnteringRule?: "coeff" | "first" | "last";
  simplexLeavingRule?: "first" | "last";
  pdhgEta?: number;
  pdhgTau?: number;
  maxitPDHG?: number;
  pdhgIneqMode?: boolean;
  pdhgHalpernMode?: boolean;
  pdhgColorByBasis?: boolean;
  centralPathIter?: number;
  objectiveAngleStep?: number;
  objectiveRotationSpeed?: number;
};

export type SharedAppState = {
  vertices: { x: number; y: number }[];
  completionMode?: CompletionMode;
  objective: { x: number; y: number } | null;
  solverMode: SolverMode;
  settings: ShareSettings;
  zScale?: number;
  is3DMode?: boolean;
};

const shareKeyMap = {
  vertices: "v",
  completionMode: "k",
  objective: "o",
  solverMode: "s",
  settings: "g",
  zScale: "l",
  is3DMode: "b",
  x: "x",
  y: "y",
  alphaMax: "a",
  correctorThreshold: "f",
  maxitIPM: "i",
  simplexDualMode: "d",
  simplexEnteringRule: "n",
  simplexLeavingRule: "w",
  pdhgEta: "e",
  pdhgTau: "t",
  maxitPDHG: "p",
  pdhgIneqMode: "m",
  pdhgHalpernMode: "j",
  pdhgColorByBasis: "h",
  centralPathIter: "c",
  objectiveAngleStep: "r",
  objectiveRotationSpeed: "q",
} as const;

const expandedShareKeyMap = Object.fromEntries(
  Object.entries(shareKeyMap).map(([key, value]) => [value, key]),
) as Record<string, string>;

const FORBIDDEN_SHARE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function transformShareObject<T>(value: T, keyMap: Record<string, string>): T {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      transformShareObject(item, keyMap),
    ) as unknown as T;
  }

  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, nestedValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const mappedKey = keyMap[key] || key;
    if (FORBIDDEN_SHARE_KEYS.has(mappedKey)) {
      continue;
    }
    result[mappedKey] = transformShareObject(nestedValue, keyMap);
  }
  return result as T;
}

export function compactSharedAppState<T>(value: T): T {
  return transformShareObject(value, shareKeyMap);
}

export function expandSharedAppState<T>(value: T): T {
  return transformShareObject(value, expandedShareKeyMap);
}

// The shared payload is the only untrusted input path in the app: a crafted
// link must not be able to push NaN or arbitrary values into the store.
const COMPLETION_MODES: ReadonlySet<string> = new Set([
  "draft",
  "closed",
  "open",
]);
const SOLVER_MODES: ReadonlySet<string> = new Set([
  "central",
  "ipm",
  "simplex",
  "pdhg",
]);

const isFinitePoint = (value: unknown): value is { x: number; y: number } =>
  typeof value === "object" &&
  value !== null &&
  Number.isFinite((value as { x: unknown }).x) &&
  Number.isFinite((value as { y: unknown }).y);

export function buildSharedStatePatch(
  sharedState: SharedAppState,
): Partial<State> {
  const mappedVertices = Array.isArray(sharedState.vertices)
    ? sharedState.vertices
        .filter(isFinitePoint)
        .map((vertex) => ({ x: vertex.x, y: vertex.y }))
    : [];
  const completionMode =
    sharedState.completionMode !== undefined &&
    COMPLETION_MODES.has(sharedState.completionMode)
      ? sharedState.completionMode
      : mappedVertices.length > 2
        ? "closed"
        : "draft";
  const solverMode = SOLVER_MODES.has(sharedState.solverMode)
    ? sharedState.solverMode
    : "central";

  return {
    vertices: mappedVertices,
    completionMode,
    objectiveVector: isFinitePoint(sharedState.objective)
      ? { x: sharedState.objective.x, y: sharedState.objective.y }
      : null,
    solverMode,
    ...(Number.isFinite(sharedState.zScale)
      ? { zScale: Math.max(0.01, Math.min(100, sharedState.zScale!)) }
      : {}),
  };
}
