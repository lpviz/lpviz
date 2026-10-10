import type { State } from "@/features/core/store";
import { COMPLETION_MODES, type CompletionMode } from "@/features/polytope-editor/editorState";
import { DEFAULT_SOLVER_SETTINGS, SOLVER_MODES, type SolverMode, type SolverSettings, type SolverSettingUpdater } from "@/features/solver/solverState";
import type { Vec } from "@lpviz/math/types";
import { type Dimension, vecFrom } from "@lpviz/math/vec";
import { clampZScale } from "@lpviz/viewport/defaults";
import { isEnteringRule, isLeavingRule } from "@lpviz/solver-engine/simplex";

export type ShareSettings = Partial<Omit<SolverSettings, "replaySpeed">>;
type SharedSettingKey = keyof ShareSettings;

// shared with every solver mode, on top of the active mode's own keys
const GLOBAL_SHARE_KEYS = ["objectiveAngleStep", "objectiveRotationSpeed"] as const;

// the settings each solver mode puts in a link
const SOLVER_SHARE_KEYS: Record<SolverMode, readonly SharedSettingKey[]> = {
  central: ["centralPathIter"],
  ipm: ["alphaMax", "correctorThreshold", "maxitIPM"],
  simplex: ["simplexDualMode", "simplexEnteringRule", "simplexLeavingRule"],
  ellipsoid: ["maxitEllipsoid", "ellipsoidDeepCuts", "ellipsoidRayShoot", "ellipsoidQueryPoint", "ellipsoidInitialScale"],
  pdhg: ["pdhgEta", "pdhgTau", "maxitPDHG", "pdhgIneqMode", "pdhgHalpernMode", "pdhgColorByBasis"],
};

const SHARED_SETTING_KEYS: readonly SharedSettingKey[] = [...GLOBAL_SHARE_KEYS, ...Object.values(SOLVER_SHARE_KEYS).flat()];

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

/** The settings a link for `mode` carries: the global ones and the mode's own. */
export function collectShareSettings(settings: SolverSettings, mode: SolverMode): ShareSettings {
  const shared: ShareSettings = {};
  const copy = <K extends SharedSettingKey>(key: K) => {
    shared[key] = settings[key];
  };
  for (const key of GLOBAL_SHARE_KEYS) copy(key);
  for (const key of SOLVER_SHARE_KEYS[mode]) copy(key);
  return shared;
}

// The share payload is untrusted. A value reaches the store only when it has
// the default's shape: a finite number, a boolean, or one of the engine's rule
// names. Anything else is dropped so a hand-edited link can neither blank a
// <select> nor throw inside the settings panel's store subscriber.
function isValidSharedSetting<K extends SharedSettingKey>(key: K, value: unknown): value is SolverSettings[K] {
  if (key === "simplexEnteringRule") return isEnteringRule(value);
  if (key === "simplexLeavingRule") return isLeavingRule(value);
  const fallback: unknown = DEFAULT_SOLVER_SETTINGS[key];
  return typeof fallback === "number" ? Number.isFinite(value) : typeof value === typeof fallback;
}

/** Push every valid shared setting into the store; unknown keys and malformed values are ignored. */
export function applySharedSettings(settings: ShareSettings, update: SolverSettingUpdater): void {
  for (const key of SHARED_SETTING_KEYS) {
    const value: unknown = settings[key];
    if (isValidSharedSetting(key, value)) update(key, value);
  }
}

// A point is kept only when it has the problem's dimension and finite coordinates, whether it
// arrived as the compact codec's tuple or a legacy link's {x, y}: a crafted link must not be able
// to push NaN or arbitrary values into the store.
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
    ...(Number.isFinite(sharedState.zScale) ? { zScale: clampZScale(sharedState.zScale!) } : {}),
  };
}
