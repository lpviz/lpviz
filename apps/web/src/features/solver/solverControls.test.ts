import { describe, expect, test } from "bun:test";
import type { SolverSettings } from "../core/store";
import type { ShareSettings } from "../share/sharedState";
import { createSolverControls } from "./solverControls";

// Share links are the app's only untrusted input. Each control's
// applySharedSettings must forward valid values and drop everything else so a
// hand-edited link can neither blank a <select> nor throw inside the settings
// panel's store subscriber.
function controls() {
  const applied: Record<string, unknown> = {};
  const list = createSolverControls({
    updateSolverSetting: (key, value) => {
      applied[key] = value;
    },
    hasUnboundedObjectiveDirection: () => false,
  });
  const byMode = (mode: string) => list.find((c) => c.mode === mode)!;
  return { applied, simplex: byMode("simplex"), ipm: byMode("ipm") };
}

const untrusted = (value: unknown) => value as ShareSettings;

describe("shared solver settings", () => {
  test("valid values reach the store", () => {
    const { applied, simplex, ipm } = controls();
    const wanted: Partial<SolverSettings> = {
      simplexDualMode: true,
      simplexEnteringRule: "coeff",
      simplexLeavingRule: "last",
      alphaMax: 0.5,
      maxitIPM: 250,
    };
    simplex.applySharedSettings(wanted);
    ipm.applySharedSettings(wanted);
    expect(applied).toEqual(wanted);
  });

  test("unknown rule names, wrong types and non-finite numbers are dropped", () => {
    const { applied, simplex, ipm } = controls();
    simplex.applySharedSettings(
      untrusted({
        simplexDualMode: "yes",
        simplexEnteringRule: "bogus",
        simplexLeavingRule: {},
      }),
    );
    ipm.applySharedSettings(
      untrusted({ alphaMax: NaN, maxitIPM: "100", correctorThreshold: 0.5 }),
    );
    expect(applied).toEqual({ correctorThreshold: 0.5 });
  });

  test("keys a control does not own are ignored", () => {
    const { applied, simplex } = controls();
    simplex.applySharedSettings({ alphaMax: 0.5, pdhgEta: 0.1 });
    expect(applied).toEqual({});
  });
});
