import { describe, expect, test } from "bun:test";
import { decodeSharedState, encodeSharedState } from "./compactUrl";
import type { SharedAppState } from "./sharedState";

const BASE: SharedAppState = {
  vertices: [
    [-4, -3],
    [4, -4],
    [6, 2],
    [0, 6],
    [-5, 3],
  ],
  completionMode: "closed",
  objective: [0.8, 0.6],
  solverMode: "ellipsoid",
  settings: {},
};

const roundTrip = (state: SharedAppState) => decodeSharedState(encodeSharedState(state));

describe("compact share links", () => {
  test("only ever emits characters that survive a linkifier", () => {
    const encoded = encodeSharedState({
      ...BASE,
      zScale: 0.1,
      is3DMode: true,
      solverStartPoint: [-1.75, 0.5],
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
      expect(vertex[0]).toBeCloseTo(BASE.vertices[i]![0], 4);
      expect(vertex[1]).toBeCloseTo(BASE.vertices[i]![1], 4);
    });
    expect(decoded!.objective![0]).toBeCloseTo(0.8, 4);
    expect(decoded!.objective![1]).toBeCloseTo(0.6, 4);
    expect(decoded!.solverMode).toBe("ellipsoid");
    expect(decoded!.completionMode).toBe("closed");
  });

  test("round-trips awkward coordinates", () => {
    const state: SharedAppState = {
      ...BASE,
      vertices: [
        [-123.4567, 987.6543],
        [0, 0],
        [0.0001, -0.0001],
        [-1000.5, 1000.5],
      ],
      objective: [-0.739752, 1.907456],
    };
    const decoded = roundTrip(state)!;
    expect(decoded.vertices.length).toBe(state.vertices.length);
    decoded.vertices.forEach((vertex, i) => {
      expect(vertex[0]).toBeCloseTo(state.vertices[i]![0], 4);
      expect(vertex[1]).toBeCloseTo(state.vertices[i]![1], 4);
    });
    expect(decoded.objective![0]).toBeCloseTo(-0.739752, 4);
    expect(decoded.objective![1]).toBeCloseTo(1.907456, 4);
  });

  test("round-trips every solver mode and completion mode", () => {
    for (const solverMode of ["central", "ipm", "simplex", "pdhg", "ellipsoid"] as const) {
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

  test("round-trips a dragged solver start point", () => {
    const decoded = roundTrip({
      ...BASE,
      solverMode: "simplex",
      solverStartPoint: [-3.5017, 2.25],
    })!;
    expect(decoded.solverStartPoint![0]).toBeCloseTo(-3.5017, 4);
    expect(decoded.solverStartPoint![1]).toBeCloseTo(2.25, 4);
  });

  test("an untouched start point costs nothing and stays null", () => {
    // null means "wherever this solver starts by default", which the receiving
    // build works out for itself — pinning it would freeze today's default into
    // the link
    const withNull = encodeSharedState({ ...BASE, solverStartPoint: null });
    expect(withNull).toBe(encodeSharedState(BASE));
    expect(decodeSharedState(withNull)!.solverStartPoint).toBeNull();
  });

  test("round-trips a 3-variable problem", () => {
    const decoded = roundTrip({
      ...BASE,
      dimension: 3,
      vertices: [
        [1, 2, 3],
        [-4, 5, -6],
        [7, -8, 9],
        [0, 0, 0],
      ],
      objective: [0.1, -0.2, 0.3],
      solverStartPoint: [1, -1, 0.5],
    })!;
    expect(decoded.dimension).toBe(3);
    expect(decoded.vertices).toHaveLength(4);
    decoded.vertices.forEach((vertex, i) => {
      expect(vertex).toHaveLength(3);
      for (let j = 0; j < 3; j++)
        expect(vertex[j]).toBeCloseTo(
          [
            [1, 2, 3],
            [-4, 5, -6],
            [7, -8, 9],
            [0, 0, 0],
          ][i]![j]!,
          4,
        );
    });
    expect(decoded.objective).toHaveLength(3);
    expect(decoded.objective![2]).toBeCloseTo(0.3, 4);
    expect(decoded.solverStartPoint).toHaveLength(3);
    expect(decoded.solverStartPoint![2]).toBeCloseTo(0.5, 4);
    expect(roundTrip(BASE)!.dimension).toBe(2);
  });

  test("still reads v2 links, which carry two coordinates and no dimension byte", () => {
    // frozen payloads from the v2 encoder: BASE, then BASE as a simplex link with a
    // dragged start point, a z scale, the 3D flag and one non-default setting
    const plain = decodeSharedState("AlEABf_wBN_UA4DiCZ-cAcC4AsCpB7-pB4DxBJ-NBt_UA4DUYYCfSQA")!;
    expect(plain.dimension).toBe(2);
    expect(plain.vertices).toHaveLength(5);
    expect(plain.vertices[2]![0]).toBeCloseTo(6, 4);
    expect(plain.objective![1]).toBeCloseTo(0.6, 4);
    expect(plain.solverMode).toBe("ellipsoid");
    const withStart = decodeSharedState("AukBBf_wBN_UA4DiCZ-cAcC4AsCpB7-pB4DxBJ-NBt_UA4DUYYCfSdYNkaMEyN8CAQLBAg")!;
    expect(withStart.solverMode).toBe("simplex");
    expect(withStart.solverStartPoint![0]).toBeCloseTo(-3.5017, 4);
    expect(withStart.solverStartPoint![1]).toBeCloseTo(2.25, 4);
    expect(withStart.zScale).toBeCloseTo(1.75, 3);
    expect(withStart.is3DMode).toBe(true);
    expect(withStart.settings.maxitIPM).toBe(321);
  });

  test("still reads v1 links, which predate the start point", () => {
    // frozen payload from the v1 encoder: two header bytes instead of three
    const v1 = "AUkF__AE39QDgOIJn5wBwLgCwKkHv6kHgPEEn40G39QDgNRhgJ9JAQLBAg";
    const decoded = decodeSharedState(v1)!;
    expect(decoded).not.toBeNull();
    expect(decoded.solverMode).toBe("simplex");
    expect(decoded.settings.maxitIPM).toBe(321);
    expect(decoded.vertices.length).toBe(5);
    expect(decoded.vertices[0]![0]).toBeCloseTo(-4, 4);
    expect(decoded.objective![0]).toBeCloseTo(0.8, 4);
    expect(decoded.solverStartPoint).toBeNull();
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
          v: BASE.vertices.map((p) => [p[0], p[1]]),
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
