import { describe, expect, test } from "bun:test";
import { decodeSharedState, encodeSharedState } from "./compactUrl";
import type { SharedAppState } from "./sharedState";

const BASE: SharedAppState = {
  vertices: [
    { x: -4, y: -3 },
    { x: 4, y: -4 },
    { x: 6, y: 2 },
    { x: 0, y: 6 },
    { x: -5, y: 3 },
  ],
  completionMode: "closed",
  objective: { x: 0.8, y: 0.6 },
  solverMode: "ellipsoid",
  settings: {},
};

const roundTrip = (state: SharedAppState) =>
  decodeSharedState(encodeSharedState(state));

describe("compact share links", () => {
  test("only ever emits characters that survive a linkifier", () => {
    const encoded = encodeSharedState({
      ...BASE,
      zScale: 0.1,
      is3DMode: true,
      settings: {
        maxitEllipsoid: 12345,
        ellipsoidQueryPoint: "volumetric",
        ellipsoidInitialScale: 2.75,
        pdhgHalpernMode: true,
      },
    });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("round-trips geometry to within a fraction of a pixel", () => {
    const decoded = roundTrip(BASE);
    expect(decoded).not.toBeNull();
    expect(decoded!.vertices.length).toBe(BASE.vertices.length);
    decoded!.vertices.forEach((vertex, i) => {
      expect(vertex.x).toBeCloseTo(BASE.vertices[i]!.x, 4);
      expect(vertex.y).toBeCloseTo(BASE.vertices[i]!.y, 4);
    });
    expect(decoded!.objective!.x).toBeCloseTo(0.8, 4);
    expect(decoded!.objective!.y).toBeCloseTo(0.6, 4);
    expect(decoded!.solverMode).toBe("ellipsoid");
    expect(decoded!.completionMode).toBe("closed");
  });

  test("round-trips awkward coordinates", () => {
    const state: SharedAppState = {
      ...BASE,
      vertices: [
        { x: -123.4567, y: 987.6543 },
        { x: 0, y: 0 },
        { x: 0.0001, y: -0.0001 },
        { x: -1000.5, y: 1000.5 },
      ],
      objective: { x: -0.739752, y: 1.907456 },
    };
    const decoded = roundTrip(state)!;
    decoded.vertices.forEach((vertex, i) => {
      expect(vertex.x).toBeCloseTo(state.vertices[i]!.x, 4);
      expect(vertex.y).toBeCloseTo(state.vertices[i]!.y, 4);
    });
    expect(decoded.objective!.x).toBeCloseTo(-0.739752, 4);
    expect(decoded.objective!.y).toBeCloseTo(1.907456, 4);
  });

  test("round-trips every solver mode and completion mode", () => {
    for (const solverMode of [
      "central",
      "ipm",
      "simplex",
      "pdhg",
      "ellipsoid",
    ] as const) {
      for (const completionMode of ["draft", "closed", "open"] as const) {
        const decoded = roundTrip({ ...BASE, solverMode, completionMode })!;
        expect(decoded.solverMode).toBe(solverMode);
        expect(decoded.completionMode).toBe(completionMode);
      }
    }
  });

  test("round-trips settings of every kind", () => {
    const settings = {
      alphaMax: 0.375,
      maxitIPM: 54321,
      simplexDualMode: true,
      pdhgColorByBasis: true,
      ellipsoidQueryPoint: "analytic" as const,
      ellipsoidDeepCuts: false,
      ellipsoidRayShoot: false,
      ellipsoidInitialScale: 3.25,
      objectiveRotationSpeed: 2.5,
    };
    const decoded = roundTrip({ ...BASE, settings })!;
    expect(decoded.settings.alphaMax).toBeCloseTo(0.375, 4);
    expect(decoded.settings.maxitIPM).toBe(54321);
    expect(decoded.settings.simplexDualMode).toBe(true);
    expect(decoded.settings.pdhgColorByBasis).toBe(true);
    expect(decoded.settings.ellipsoidQueryPoint).toBe("analytic");
    expect(decoded.settings.ellipsoidDeepCuts).toBe(false);
    expect(decoded.settings.ellipsoidRayShoot).toBe(false);
    expect(decoded.settings.ellipsoidInitialScale).toBeCloseTo(3.25, 4);
    expect(decoded.settings.objectiveRotationSpeed).toBeCloseTo(2.5, 4);
  });

  test("omits settings left at their default", () => {
    const withDefaults = encodeSharedState({
      ...BASE,
      settings: { maxitEllipsoid: 500, ellipsoidDeepCuts: true },
    });
    const withNone = encodeSharedState({ ...BASE, settings: {} });
    expect(withDefaults).toBe(withNone);
  });

  test("round-trips the 3D flag and z scale", () => {
    const decoded = roundTrip({ ...BASE, is3DMode: true, zScale: 1.75 })!;
    expect(decoded.is3DMode).toBe(true);
    expect(decoded.zScale).toBeCloseTo(1.75, 3);
    const flat = roundTrip({ ...BASE })!;
    expect(flat.is3DMode).toBeUndefined();
  });

  test("handles an empty drawing and a missing objective", () => {
    const decoded = roundTrip({
      vertices: [],
      completionMode: "draft",
      objective: null,
      solverMode: "central",
      settings: {},
    })!;
    expect(decoded.vertices).toEqual([]);
    expect(decoded.objective).toBeNull();
  });

  test("is shorter than the JSONCrush payload it replaces", async () => {
    const JSONCrush = (await import("jsoncrush")).default;
    const legacy = encodeURIComponent(
      JSONCrush.crush(
        JSON.stringify({
          v: BASE.vertices.map((p) => ({ x: p.x, y: p.y })),
          k: "closed",
          o: BASE.objective,
          s: "ellipsoid",
          g: {},
        }),
      ),
    );
    expect(encodeSharedState(BASE).length).toBeLessThan(legacy.length);
  });

  test("rejects payloads it should not try to read", () => {
    expect(decodeSharedState("")).toBeNull();
    // an old JSONCrush link, which must fall through to the legacy decoder
    expect(decodeSharedState("('v!%5BB3.3A-3.3*2.2C-2")).toBeNull();
    expect(decodeSharedState("not/base64url+at@all")).toBeNull();
    // valid base64url, wrong version byte
    expect(decodeSharedState("_____w")).toBeNull();
  });

  test("survives truncation without throwing", () => {
    const encoded = encodeSharedState({
      ...BASE,
      settings: { maxitIPM: 999, simplexDualMode: true },
    });
    for (let cut = 1; cut < encoded.length; cut++) {
      expect(() => decodeSharedState(encoded.slice(0, cut))).not.toThrow();
    }
  });
});
