import JSONCrush from "jsoncrush";
import type { SharedAppState } from "./sharedState";

// Links shared before the base64url format (see compactUrl.ts) are still out in the world — in
// chat logs, in the README, in a paper — so their JSONCrush payload stays readable. This maps the
// short keys back to their full names. Every key that ever shipped stays here ("E"/"L" carried the
// simplex pivot rules); a retired key such as "w" (ipmColorByPhase) or "u" (zAxisOffsetOnly) may
// still appear in old links.
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

const fullKeyOf = Object.fromEntries(Object.entries(shareKeyMap).map(([key, value]) => [value, key])) as Record<string, string>;

const FORBIDDEN_SHARE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function expandKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(expandKeys);

  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const fullKey = fullKeyOf[key] || key;
    if (FORBIDDEN_SHARE_KEYS.has(fullKey)) continue;
    result[fullKey] = expandKeys(nested);
  }
  return result;
}

/** A link from before the compact codec, which always held a two-variable problem. */
export function decodeLegacySharedState(encoded: string): SharedAppState {
  return { ...(expandKeys(JSON.parse(JSONCrush.uncrush(encoded))) as SharedAppState), dimension: 2 };
}
