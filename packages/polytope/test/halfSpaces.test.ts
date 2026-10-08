import { describe, expect, test } from "bun:test";
import { centroid } from "@lpviz/math/polygon";
import type { Constraint } from "@lpviz/math/types";
import { classifyPolytope, verticesFromConstraints } from "../src/halfSpaces";

// unit-normalized constraints for the square [0,4] x [0,4]
const SQUARE: Constraint[] = [
  [0, -1, 0],
  [1, 0, 4],
  [0, 1, 4],
  [-1, 0, 0],
];

describe("verticesFromConstraints", () => {
  test("returns full-precision vertices", () => {
    const third: Constraint[] = [
      [0, -1, 0],
      [Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2],
      [-1, 0, 0],
    ];
    const verts = verticesFromConstraints(third);
    expect(verts.length).toBe(3);
    const hasExact = verts.some(([x, y]) => Math.abs(x - 0) < 1e-9 && Math.abs(y - 1) < 1e-9);
    expect(hasExact).toBe(true);
  });

  test("does not collapse a sliver thinner than 0.005 into duplicates", () => {
    // x in [0, 0.004], y in [0, 1]
    const sliver: Constraint[] = [
      [0, -1, 0],
      [1, 0, 0.004],
      [0, 1, 1],
      [-1, 0, 0],
    ];
    const verts = verticesFromConstraints(sliver);
    expect(verts.length).toBe(4);
    const center = centroid(verts);
    const strictlyFeasible = sliver.every(([A, B, C]) => A * center[0] + B * center[1] < C);
    expect(strictlyFeasible).toBe(true);
  });
});

describe("classifyPolytope", () => {
  test("classifies a closed square as bounded", () => {
    expect(classifyPolytope(SQUARE, verticesFromConstraints(SQUARE), true)).toBe("bounded");
  });

  test("does not call a receding region with 3 vertices bounded", () => {
    // x >= 0, y >= 0, x + y >= 1, y <= 2: three vertices, recedes along +x
    const s = Math.SQRT1_2;
    const open: Constraint[] = [
      [-1, 0, 0],
      [0, -1, 0],
      [-s, -s, -s],
      [0, 1, 2],
    ];
    expect(classifyPolytope(open, verticesFromConstraints(open), true)).toBe("unbounded");
  });

  test("an open chain is bounded only when told its closure's vertices", () => {
    expect(classifyPolytope(SQUARE, [], false)).toBe("unbounded");
    expect(classifyPolytope(SQUARE, verticesFromConstraints(SQUARE), false)).toBe("bounded");
    expect(classifyPolytope([], [], false)).toBe("degenerate");
  });
});
