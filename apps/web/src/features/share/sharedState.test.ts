import { describe, expect, test } from "bun:test";
import { DEFAULT_SOLVER_SETTINGS, type SolverSettings } from "../core/store";
import { applySharedSettings, collectShareSettings, type ShareSettings } from "./sharedState";

// Share links are the app's only untrusted input: a hand-edited link must be
// able to neither blank a <select> nor throw inside the settings panel's store
// subscriber, so only values of the default's shape reach the store.
function applied(settings: ShareSettings) {
  const out: Record<string, unknown> = {};
  applySharedSettings(settings, (key, value) => {
    out[key] = value;
  });
  return out;
}

const untrusted = (value: unknown) => value as ShareSettings;

describe("shared solver settings", () => {
  test("valid values reach the store", () => {
    const wanted: Partial<SolverSettings> = {
      simplexDualMode: true,
      simplexEnteringRule: "coeff",
      simplexLeavingRule: "last",
      alphaMax: 0.5,
      maxitIPM: 250,
      objectiveAngleStep: 0.2,
    };
    expect(applied(wanted)).toEqual(wanted);
  });

  test("unknown rule names, wrong types and non-finite numbers are dropped", () => {
    expect(
      applied(
        untrusted({
          simplexDualMode: "yes",
          simplexEnteringRule: "bogus",
          simplexLeavingRule: {},
          alphaMax: NaN,
          maxitIPM: "100",
          objectiveRotationSpeed: "fast",
          correctorThreshold: 0.5,
        }),
      ),
    ).toEqual({ correctorThreshold: 0.5 });
  });

  test("keys that are not settings are ignored", () => {
    expect(applied(untrusted({ bogus: 1, replaySpeed: 5 }))).toEqual({});
  });

  test("a link carries the global settings and the active solver's own", () => {
    const settings = { ...DEFAULT_SOLVER_SETTINGS, alphaMax: 0.5, pdhgEta: 0.1, objectiveAngleStep: 0.2 };
    expect(collectShareSettings(settings, "ipm")).toEqual({
      objectiveAngleStep: 0.2,
      objectiveRotationSpeed: DEFAULT_SOLVER_SETTINGS.objectiveRotationSpeed,
      alphaMax: 0.5,
      correctorThreshold: DEFAULT_SOLVER_SETTINGS.correctorThreshold,
      maxitIPM: DEFAULT_SOLVER_SETTINGS.maxitIPM,
    });
    expect(Object.keys(collectShareSettings(settings, "pdhg"))).not.toContain("alphaMax");
  });
});
