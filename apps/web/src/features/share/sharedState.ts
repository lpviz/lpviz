import type { State } from "@/features/core/store";
import { COMPLETION_MODES, type CompletionMode } from "@/features/polytope-editor/editorState";
import {
  DEFAULT_SOLVER_SETTINGS,
  SHARED_SETTING_KEYS,
  SOLVER_MODES,
  sharedSettingKeys,
  type SharedSettingKey,
  type ShareSettings,
  type SolverMode,
  type SolverSettings,
} from "@/features/solver/solverSettings";
import type { Vec } from "@lpviz/math/types";
import { type Dimension, vecFrom } from "@lpviz/math/vec";
import { clampZScale } from "@lpviz/viewport/defaults";
import { isEnteringRule, isLeavingRule } from "@lpviz/solver-engine/simplex";

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
  for (const key of sharedSettingKeys(mode)) copy(key);
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

/** The shared settings worth keeping: unknown keys and malformed values are dropped. */
export function validSharedSettings(settings: ShareSettings): ShareSettings {
  const valid: ShareSettings = {};
  const keep = <K extends SharedSettingKey>(key: K) => {
    const value: unknown = settings[key];
    if (isValidSharedSetting(key, value)) valid[key] = value;
  };
  for (const key of SHARED_SETTING_KEYS) keep(key);
  return valid;
}

// A point is kept only when it has the problem's dimension and finite coordinates, whether it
// arrived as the compact codec's tuple or a legacy link's {x, y}: a crafted link must not be able
// to push NaN or arbitrary values into the store.
function finiteVec(value: unknown, dimension: Dimension): Vec | null {
  const coords: unknown[] | null = Array.isArray(value) ? value : typeof value === "object" && value !== null ? [(value as { x: unknown }).x, (value as { y: unknown }).y] : null;
  if (!coords || coords.length !== dimension || !coords.every((coordinate): coordinate is number => typeof coordinate === "number" && Number.isFinite(coordinate))) return null;
  return vecFrom(coords);
}

/** The store patch a link applies, over the current settings (a link carries only some). */
export function buildSharedStatePatch(sharedState: SharedAppState, { dimension, solverSettings }: Pick<State, "dimension" | "solverSettings">): Partial<State> {
  const mappedVertices = Array.isArray(sharedState.vertices) ? sharedState.vertices.map((vertex) => finiteVec(vertex, dimension)).filter((vertex): vertex is Vec => vertex !== null) : [];
  const completionMode =
    sharedState.completionMode !== undefined && COMPLETION_MODES.includes(sharedState.completionMode) ? sharedState.completionMode : mappedVertices.length > 2 ? "closed" : "draft";
  const solverMode = SOLVER_MODES.includes(sharedState.solverMode) ? sharedState.solverMode : "central";

  return {
    vertices: mappedVertices,
    completionMode,
    objectiveVector: finiteVec(sharedState.objective, dimension),
    solverMode,
    solverSettings: { ...solverSettings, ...validSharedSettings(sharedState.settings ?? {}) },
    // always written, so loading a link clears a start point left over from
    // whatever the user was doing before
    solverStartPoint: finiteVec(sharedState.solverStartPoint, dimension),
    ...(Number.isFinite(sharedState.zScale) ? { zScale: clampZScale(sharedState.zScale!) } : {}),
  };
}
