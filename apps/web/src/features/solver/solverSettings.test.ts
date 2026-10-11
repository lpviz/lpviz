import { describe, expect, test } from "bun:test";
import { LEGACY_SETTING_KEYS, SHARED_SETTING_KEYS, sharedSettingKeys, WIRED_SETTINGS } from "./solverSettings";

// The spec table is what the share formats derive from, so its wire and legacy
// identities must be what links out in the world were written with.
describe("solver setting specs", () => {
  test("the wire slots are 0..n-1, each taken once", () => {
    expect(WIRED_SETTINGS.map(({ wire }) => wire.slot)).toEqual([...WIRED_SETTINGS.keys()]);
  });

  test("the legacy keys are distinct", () => {
    const keys = Object.values(LEGACY_SETTING_KEYS);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("a solver's link carries the global settings and its own, never another solver's", () => {
    const ipm = sharedSettingKeys("ipm");
    expect(ipm).toContain("alphaMax");
    expect(ipm).toContain("objectiveAngleStep");
    expect(ipm).not.toContain("pdhgEta");
    expect(SHARED_SETTING_KEYS).not.toContain("replayDurationMs");
  });
});
