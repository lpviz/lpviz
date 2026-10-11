import { DEFAULT_REPLAY_DURATION_MS } from "@/features/solver/replayDuration";
import type { QueryPoint } from "@lpviz/solver-engine/cuttingPlane";
import { ENTERING_RULES, type EnteringRule, LEAVING_RULES, type LeavingRule } from "@lpviz/solver-engine/simplex";

// Index order is the share link's wire identity (compactUrl): only ever append.
export const SOLVER_MODES = ["central", "ipm", "simplex", "pdhg", "ellipsoid"] as const;
export type SolverMode = (typeof SOLVER_MODES)[number];

export const SOLVER_LABELS: Record<SolverMode, string> = { central: "Central Path", ipm: "IPM", simplex: "Simplex", pdhg: "PDHG", ellipsoid: "Ellipsoid" };

// Which point of the localizing set the ellipsoid mode queries next: "ellipsoid" is the ellipsoid
// method proper, the rest localize with a polyhedron of cuts (see @lpviz/solver-engine/cuttingPlane).
const QUERY_POINTS = ["ellipsoid", "chebyshev", "analytic", "volumetric"] as const satisfies readonly ("ellipsoid" | QueryPoint)[];
export type EllipsoidQueryPoint = (typeof QUERY_POINTS)[number];

export type SolverSettings = {
  alphaMax: number;
  correctorThreshold: number;
  maxitIPM: number;
  simplexDualMode: boolean;
  simplexEnteringRule: EnteringRule;
  simplexLeavingRule: LeavingRule;
  pdhgEta: number;
  pdhgTau: number;
  maxitPDHG: number;
  pdhgIneqMode: boolean;
  pdhgHalpernMode: boolean;
  pdhgColorByBasis: boolean;
  centralPathIter: number;
  maxitEllipsoid: number;
  ellipsoidDeepCuts: boolean;
  ellipsoidRayShoot: boolean;
  ellipsoidQueryPoint: EllipsoidQueryPoint;
  ellipsoidInitialScale: number;
  objectiveAngleStep: number;
  objectiveRotationSpeed: number;
  // Total wall-clock length of an "Animate" replay: the replay maps elapsed time onto the whole
  // iterate path (see replayController). Adjusted with the +/- keys.
  replayDurationMs: number;
};

export type SolverSettingUpdater = <K extends keyof SolverSettings>(key: K, value: SolverSettings[K]) => void;

/** The settings a `<select>` chooses from a vocabulary. */
export type SelectSettingKey = { [K in keyof SolverSettings]: SolverSettings[K] extends string ? K : never }[keyof SolverSettings];
/** The numeric settings. */
export type NumberSettingKey = { [K in keyof SolverSettings]: SolverSettings[K] extends number ? K : never }[keyof SolverSettings];
/** A slider's range, as its min, max and step attributes (strings, exactly as the panel writes them). */
export type SliderRange = readonly [min: string, max: string, step: string];

// how a setting travels in a share link: its slot is its identity on the wire, so a slot never
// changes or is reused; a new shared setting takes the next free one
type SettingWire = { slot: number; codec: "bool" | "int" | { scaled: number } | { enumeration: readonly string[] } };

type SettingSpec<V> = {
  default: V;
  /** the solver whose panel shows it and whose links carry it; "global": every link; "local": never shared */
  owner: SolverMode | "global" | "local";
  /** a select's vocabulary in the panel's order (the wire's order is its codec's); a link's value must be one of them */
  values?: [V] extends [string] ? readonly V[] : never;
  /** a slider setting's range */
  range?: [V] extends [number] ? SliderRange : never;
  /** absent for a setting that links do not carry */
  wire?: SettingWire;
  /** its key in a link from before the compact codec (see legacyLink) */
  legacyKey?: string;
};

// Every solver setting in one place: its default, who owns it, and how it is shared. The share
// codec, the legacy link reader and the per-solver link contents all derive from this table, so
// adding a setting is one entry here (plus its control in the panel).
const SOLVER_SETTING_SPECS: { [K in keyof SolverSettings]: SettingSpec<SolverSettings[K]> } = {
  alphaMax: { default: 0.1, owner: "ipm", range: ["0.001", "1", "0.001"], wire: { slot: 0, codec: { scaled: 1e4 } }, legacyKey: "a" },
  correctorThreshold: { default: 0.9, owner: "ipm", range: ["0.001", "0.999", "0.001"], wire: { slot: 1, codec: { scaled: 1e4 } }, legacyKey: "f" },
  maxitIPM: { default: 1000, owner: "ipm", wire: { slot: 2, codec: "int" }, legacyKey: "i" },
  simplexDualMode: { default: false, owner: "simplex", wire: { slot: 3, codec: "bool" }, legacyKey: "d" },
  // the pivot rules have no slot yet: a link does not carry them (a codec bump, to be its own decision)
  simplexEnteringRule: { default: "first", owner: "simplex", values: ENTERING_RULES, legacyKey: "E" },
  simplexLeavingRule: { default: "first", owner: "simplex", values: LEAVING_RULES, legacyKey: "L" },
  pdhgEta: { default: 0.25, owner: "pdhg", range: ["0.001", "0.750", "0.001"], wire: { slot: 4, codec: { scaled: 1e4 } }, legacyKey: "e" },
  pdhgTau: { default: 0.25, owner: "pdhg", range: ["0.001", "0.750", "0.001"], wire: { slot: 5, codec: { scaled: 1e4 } }, legacyKey: "t" },
  maxitPDHG: { default: 1000, owner: "pdhg", wire: { slot: 6, codec: "int" }, legacyKey: "p" },
  pdhgIneqMode: { default: true, owner: "pdhg", wire: { slot: 7, codec: "bool" }, legacyKey: "m" },
  pdhgHalpernMode: { default: false, owner: "pdhg", wire: { slot: 8, codec: "bool" }, legacyKey: "j" },
  pdhgColorByBasis: { default: false, owner: "pdhg", wire: { slot: 9, codec: "bool" }, legacyKey: "h" },
  centralPathIter: { default: 75, owner: "central", range: ["2", "100", "1"], wire: { slot: 10, codec: "int" }, legacyKey: "c" },
  maxitEllipsoid: { default: 500, owner: "ellipsoid", wire: { slot: 11, codec: "int" }, legacyKey: "n" },
  ellipsoidDeepCuts: { default: true, owner: "ellipsoid", wire: { slot: 12, codec: "bool" }, legacyKey: "u" },
  ellipsoidRayShoot: { default: true, owner: "ellipsoid", wire: { slot: 13, codec: "bool" }, legacyKey: "z" },
  // every lowercase legacy letter is taken; uppercase never collides with them
  ellipsoidQueryPoint: { default: "ellipsoid", owner: "ellipsoid", values: QUERY_POINTS, wire: { slot: 14, codec: { enumeration: QUERY_POINTS } }, legacyKey: "Q" },
  ellipsoidInitialScale: { default: 1.5, owner: "ellipsoid", range: ["1.05", "4", "0.05"], wire: { slot: 15, codec: { scaled: 1e4 } }, legacyKey: "w" },
  objectiveAngleStep: { default: 0.1, owner: "global", range: ["0.01", "0.5", "0.01"], wire: { slot: 16, codec: { scaled: 1e4 } }, legacyKey: "r" },
  objectiveRotationSpeed: { default: 1, owner: "global", range: ["0.2", "3", "0.1"], wire: { slot: 17, codec: { scaled: 1e4 } }, legacyKey: "q" },
  replayDurationMs: { default: DEFAULT_REPLAY_DURATION_MS, owner: "local" },
};

const SOLVER_SETTING_KEYS = Object.keys(SOLVER_SETTING_SPECS) as (keyof SolverSettings)[];

// exported so share links can omit any setting still at its default
export const DEFAULT_SOLVER_SETTINGS = Object.fromEntries(SOLVER_SETTING_KEYS.map((key) => [key, SOLVER_SETTING_SPECS[key].default])) as SolverSettings;

/** A slider setting's range. */
export function settingRange(key: NumberSettingKey): SliderRange {
  const { range } = SOLVER_SETTING_SPECS[key];
  if (!range) throw new Error(`${key} has no slider range`);
  return range;
}

/** A select's vocabulary, in the panel's order. */
export const settingValues = <K extends SelectSettingKey>(key: K): readonly SolverSettings[K][] => SOLVER_SETTING_SPECS[key].values as readonly SolverSettings[K][];

/**
 * Whether an untrusted value may be stored under `key`: one of a select's values, else the
 * default's shape (a finite number, a boolean). Anything else would blank a `<select>` or throw
 * inside the settings panel's store subscriber.
 */
export function isSettingValue<K extends keyof SolverSettings>(key: K, value: unknown): value is SolverSettings[K] {
  const { default: fallback, values } = SOLVER_SETTING_SPECS[key];
  if (values) return (values as readonly unknown[]).includes(value);
  return typeof fallback === "number" ? Number.isFinite(value) : typeof value === typeof fallback;
}

/** The settings a share link may carry (every one but the local replay length). */
export type ShareSettings = Partial<Omit<SolverSettings, "replayDurationMs">>;
export type SharedSettingKey = keyof ShareSettings;

const isShared = (key: keyof SolverSettings): key is SharedSettingKey => SOLVER_SETTING_SPECS[key].owner !== "local";

export const SHARED_SETTING_KEYS: readonly SharedSettingKey[] = SOLVER_SETTING_KEYS.filter(isShared);

/** The settings a link for `mode` carries: the global ones and the mode's own. */
export const sharedSettingKeys = (mode: SolverMode): SharedSettingKey[] => SHARED_SETTING_KEYS.filter((key) => [mode, "global"].includes(SOLVER_SETTING_SPECS[key].owner));

/** The shared settings on the wire, in slot order (so the index is the slot). */
export const WIRED_SETTINGS: readonly { key: SharedSettingKey; wire: SettingWire }[] = SHARED_SETTING_KEYS.flatMap((key) => {
  const { wire } = SOLVER_SETTING_SPECS[key];
  return wire ? [{ key, wire }] : [];
}).sort((a, b) => a.wire.slot - b.wire.slot);

/** The settings' keys in a link from before the compact codec. */
export const LEGACY_SETTING_KEYS: Record<string, string> = Object.fromEntries(
  SOLVER_SETTING_KEYS.flatMap((key) => {
    const { legacyKey } = SOLVER_SETTING_SPECS[key];
    return legacyKey ? [[key, legacyKey]] : [];
  }),
);
