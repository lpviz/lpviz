import { COMPLETION_MODES, SOLVER_MODES, type CompletionMode, type Dimension, type SolverMode, type SolverSettings, type State } from "@/features/core/store";
import type { Vec } from "@lpviz/math/types";
import { vecFrom } from "@lpviz/math/vec";

export type ShareSettings = Partial<Omit<SolverSettings, "replaySpeed">>;

// shared with every solver mode, on top of the active control's own keys
export const GLOBAL_SHARE_KEYS = ["objectiveAngleStep", "objectiveRotationSpeed"] as const;

export type SharedAppState = {
  /** how many coordinates every point carries; absent in links from before the 3-variable editor (two) */
  dimension?: Dimension;
  vertices: Vec[];
  completionMode?: CompletionMode;
  objective: Vec | null;
  solverMode: SolverMode;
  settings: ShareSettings;
  /** Null means the solver's own default start, not "no start point". */
  solverStartPoint?: Vec | null;
  zScale?: number;
  is3DMode?: boolean;
};

// Decode-only since links became base64url (see compactUrl.ts): this maps the
// short keys of the older JSONCrush payloads back to their full names, so links
// shared before that change still open. Every key that ever shipped stays here
// ("E"/"L" carried the simplex pivot rules); a retired key such as "w"
// (ipmColorByPhase) or "u" (zAxisOffsetOnly) may still appear in old links.
const shareKeyMap = {
  vertices: "v",
  completionMode: "k",
  objective: "o",
  solverMode: "s",
  settings: "g",
  zScale: "l",
  is3DMode: "b",
  alphaMax: "a",
  correctorThreshold: "f",
  maxitIPM: "i",
  simplexDualMode: "d",
  simplexEnteringRule: "E",
  simplexLeavingRule: "L",
  pdhgEta: "e",
  pdhgTau: "t",
  maxitPDHG: "p",
  pdhgIneqMode: "m",
  pdhgHalpernMode: "j",
  pdhgColorByBasis: "h",
  centralPathIter: "c",
  maxitEllipsoid: "n",
  ellipsoidDeepCuts: "u",
  ellipsoidRayShoot: "z",
  // every lowercase letter is taken; uppercase never collides with them
  ellipsoidQueryPoint: "Q",
  ellipsoidInitialScale: "w",
  objectiveAngleStep: "r",
  objectiveRotationSpeed: "q",
} as const;

const expandedShareKeyMap = Object.fromEntries(Object.entries(shareKeyMap).map(([key, value]) => [value, key])) as Record<string, string>;

const FORBIDDEN_SHARE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function transformShareObject<T>(value: T, keyMap: Record<string, string>): T {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => transformShareObject(item, keyMap)) as unknown as T;
  }

  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    const mappedKey = keyMap[key] || key;
    if (FORBIDDEN_SHARE_KEYS.has(mappedKey)) {
      continue;
    }
    result[mappedKey] = transformShareObject(nestedValue, keyMap);
  }
  return result as T;
}

export function expandSharedAppState<T>(value: T): T {
  return transformShareObject(value, expandedShareKeyMap);
}

// The shared payload is the only untrusted input path in the app: a crafted
// link must not be able to push NaN or arbitrary values into the store. A point
// is kept only when it has the problem's dimension and finite coordinates,
// whether it arrived as the compact codec's tuple or a legacy link's {x, y}.
function finiteVec(value: unknown, dimension: Dimension): Vec | null {
  const coords: unknown[] | null = Array.isArray(value) ? value : typeof value === "object" && value !== null ? [(value as { x: unknown }).x, (value as { y: unknown }).y] : null;
  if (!coords || coords.length !== dimension || !coords.every((coordinate): coordinate is number => typeof coordinate === "number" && Number.isFinite(coordinate))) return null;
  return vecFrom(coords);
}

export function buildSharedStatePatch(sharedState: SharedAppState, dimension: Dimension): Partial<State> {
  const mappedVertices = Array.isArray(sharedState.vertices) ? sharedState.vertices.map((vertex) => finiteVec(vertex, dimension)).filter((vertex): vertex is Vec => vertex !== null) : [];
  const completionMode =
    sharedState.completionMode !== undefined && COMPLETION_MODES.includes(sharedState.completionMode) ? sharedState.completionMode : mappedVertices.length > 2 ? "closed" : "draft";
  const solverMode = SOLVER_MODES.includes(sharedState.solverMode) ? sharedState.solverMode : "central";

  return {
    vertices: mappedVertices,
    completionMode,
    objectiveVector: finiteVec(sharedState.objective, dimension),
    solverMode,
    // always written, so loading a link clears a start point left over from
    // whatever the user was doing before
    solverStartPoint: finiteVec(sharedState.solverStartPoint, dimension),
    ...(Number.isFinite(sharedState.zScale) ? { zScale: Math.max(0.01, Math.min(100, sharedState.zScale!)) } : {}),
  };
}
