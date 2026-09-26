import { describe, expect, test } from "bun:test";
import { deriveRegionFromPoints } from "../src/regionAssembly";
import { buildConstraintRep } from "../src/constraintRep";
import { isConvexChain } from "@lpviz/math/geometry";
import type { Vertices } from "@lpviz/math/types";

describe("deriveRegionFromPoints", () => {
  test("closed convex polygons are bounded", () => {
    const square: Vertices = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ];
    expect(deriveRegionFromPoints(square, "closed").kind).toBe("bounded");
  });

  test("an unconstrained open region is degenerate, not empty", () => {
    expect(deriveRegionFromPoints([[1, 1]], "open").kind).toBe("degenerate");
    expect(
      deriveRegionFromPoints(
        [
          [1, 1],
          [1, 1],
        ],
        "open",
      ).kind,
    ).toBe("degenerate");
  });

  test("a single open half-plane is unbounded", () => {
    expect(
      deriveRegionFromPoints(
        [
          [0, 0],
          [2, 0],
        ],
        "open",
      ).kind,
    ).toBe("unbounded");
  });

  test("an open chain that closes onto itself is bounded", () => {
    const chain: Vertices = [
      [0, 0],
      [1, 0],
      [1, 1],
      [-3, 1],
      [-3, -1],
    ];
    expect(deriveRegionFromPoints(chain, "open").kind).toBe("bounded");
  });
});

describe("open chain half-plane orientation", () => {
  // Regression: the interior side of an open chain's edges used to be read off
  // the chain's centroid. That reference is a mean over all the points, so one
  // distant vertex could drag it across an edge and leave that edge's
  // half-plane facing outward, which then cut the nodes either side of it out
  // of the user's own region while still leaving it feasible.
  //
  // Reported against this share link, a four-node chain whose first node sat
  // far outside the triangle the rest described:
  //   https://lpviz.net/?s=AsIABJCr0QH0nI4B78iOApm_qQH0rSmGziCbrAn1xArq284D6q7OBWQA
  const FAR_Flung_CHAIN: Vertices = [
    [171.4888, 116.5114],
    [-50.1616, -22.3379],
    [-16.2806, 4.376],
    [-23.9364, -4.2571],
  ];

  const violating = (chain: Vertices) => {
    const { lines } = buildConstraintRep(chain, false);
    const out: number[] = [];
    chain.forEach(([x, y]) => {
      lines.forEach(([A, B, C]) => {
        const excess = A * x + B * y - C;
        if (excess > 1e-6) out.push(excess);
      });
    });
    return out;
  };

  test("a distant node cannot flip a neighbouring edge's half-plane", () => {
    // v1 sits on the last edge's extension but was excluded by it: the third
    // edge's half-plane was facing outward
    expect(violating(FAR_Flung_CHAIN).length).toBe(1);
    expect(buildConstraintRep(FAR_Flung_CHAIN, false).lines[2]![0]).toBeCloseTo(
      0.748186,
      5,
    );
  });

  test("each edge's half-plane contains the next node along the chain", () => {
    // the local property the orientation must guarantee whatever the node
    // placement: v[i+2] is on the interior side of edge i
    let checked = 0;
    let seed = 42;
    const rnd = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < 20000; i++) {
      const n = 3 + Math.floor(rnd() * 6);
      const pts: Vertices = Array.from({ length: n }, () => [
        (rnd() * 2 - 1) * 100,
        (rnd() * 2 - 1) * 100,
      ]);
      if (new Set(pts.map(([x, y]) => `${x},${y}`)).size !== n) continue;
      const asPoints = pts.map(([x, y]) => ({ x, y }));
      if (!isConvexChain(asPoints)) continue;
      const { lines } = buildConstraintRep(pts, false);
      for (let e = 0; e + 2 < n && e < lines.length; e++) {
        const [A, B, C] = lines[e]!;
        const [px, py] = pts[e + 2]!;
        expect(A * px! + B * py! - C).toBeLessThanOrEqual(1e-6);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });

  test("a right-turning chain and its mirror are both internally valid", () => {
    // these two are mirror images and turn opposite ways, so the fix has to
    // orient them by opposite rules; neither may exclude its own nodes
    const up: Vertices = [
      [0, 0],
      [2, 0],
      [2, 2],
    ];
    const down: Vertices = up.map<[number, number]>(
      ([x, y]) => [x, -y] as [number, number],
    );
    expect(violating(up).length).toBe(0);
    expect(violating(down).length).toBe(0);

    // each keeps the interior on the side its own turn implies
    const upLines = buildConstraintRep(up, false).lines;
    const downLines = buildConstraintRep(down, false).lines;
    // the first edge runs +x in both, so the interior is above in one and below
    // in the other
    expect(upLines[0]![1]).toBeLessThan(0);
    expect(downLines[0]![1]).toBeGreaterThan(0);
    expect(deriveRegionFromPoints(up, "open").kind).not.toBe("empty");
    expect(deriveRegionFromPoints(down, "open").kind).not.toBe("empty");
  });

  test("a collinear chain keeps its previous orientation", () => {
    const flat: Vertices = [
      [0, 0],
      [1, 0],
      [2, 0],
    ];
    expect(buildConstraintRep(flat, false).lines.length).toBe(2);
  });
});
