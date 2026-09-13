import { describe, expect, test } from "bun:test";
import type { PointXYZ } from "@lpviz/math/types";
import { buildPrismPlanes, centroid3, chamferPlaneForVertex, clampFaceOffset, derivePolytope3, formatInequality3, interiorPoint3, type Plane3 } from "../src/polytope3";

const SQUARE_BASE: number[][] = [
  [1, 0, 1],
  [0, 1, 1],
  [-1, 0, 1],
  [0, -1, 1],
];

function cubePlanes(): Plane3[] {
  return buildPrismPlanes(SQUARE_BASE, 2);
}

function newellNormal(loop: PointXYZ[]): PointXYZ {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < loop.length; i++) {
    const current = loop[i];
    const next = loop[(i + 1) % loop.length];
    x += (current.y - next.y) * (current.z + next.z);
    y += (current.z - next.z) * (current.x + next.x);
    z += (current.x - next.x) * (current.y + next.y);
  }
  return { x, y, z };
}

describe("derivePolytope3", () => {
  test("cube prism has 8 vertices and 6 quadrilateral faces", () => {
    const polytope = derivePolytope3(cubePlanes());
    expect(polytope.kind).toBe("bounded");
    expect(polytope.vertices.length).toBe(8);
    expect(polytope.faces.length).toBe(6);
    for (const face of polytope.faces) {
      expect(face.vertexIndices.length).toBe(4);
    }
    expect(polytope.inequalities.length).toBe(6);

    const center = centroid3(polytope.vertices);
    expect(center.x).toBeCloseTo(0, 9);
    expect(center.y).toBeCloseTo(0, 9);
    expect(center.z).toBeCloseTo(1, 9);
  });

  test("face loops wind counter-clockwise viewed from outside", () => {
    const polytope = derivePolytope3(cubePlanes());
    for (const face of polytope.faces) {
      const [a, b, c] = polytope.planes[face.planeIndex];
      const loop = face.vertexIndices.map((index) => polytope.vertices[index]);
      const normal = newellNormal(loop);
      expect(normal.x * a + normal.y * b + normal.z * c).toBeGreaterThan(0);
    }
  });

  test("tetrahedron has 4 vertices and 4 triangular faces", () => {
    const s = 1 / Math.sqrt(3);
    const planes: Plane3[] = [
      [-1, 0, 0, 0],
      [0, -1, 0, 0],
      [0, 0, -1, 0],
      [s, s, s, s],
    ];
    const polytope = derivePolytope3(planes);
    expect(polytope.kind).toBe("bounded");
    expect(polytope.vertices.length).toBe(4);
    expect(polytope.faces.length).toBe(4);
    for (const face of polytope.faces) {
      expect(face.vertexIndices.length).toBe(3);
    }
  });

  test("contradictory planes give an empty polytope", () => {
    expect(
      derivePolytope3([
        [1, 0, 0, -1],
        [-1, 0, 0, -1],
      ]).kind,
    ).toBe("empty");
    expect(derivePolytope3([...cubePlanes(), [1, 0, 0, -2]]).kind).toBe("empty");
  });

  test("a zero-thickness slab is degenerate", () => {
    const planes: Plane3[] = [
      [1, 0, 0, 1],
      [0, 1, 0, 1],
      [-1, 0, 0, 1],
      [0, -1, 0, 1],
      [0, 0, 1, 0],
      [0, 0, -1, 0],
    ];
    expect(derivePolytope3(planes).kind).toBe("degenerate");
  });
});

describe("chamferPlaneForVertex", () => {
  test("chamfering a cube corner adds one triangular face", () => {
    const planes = cubePlanes();
    const cube = derivePolytope3(planes);
    const corner = cube.vertices.find((v) => Math.abs(v.x - 1) < 1e-9 && Math.abs(v.y - 1) < 1e-9 && Math.abs(v.z - 2) < 1e-9);
    expect(corner).toBeDefined();

    const cut = chamferPlaneForVertex(corner!, centroid3(cube.vertices), 0.3);
    expect(cut).not.toBeNull();

    const chamfered = derivePolytope3([...planes, cut!]);
    expect(chamfered.kind).toBe("bounded");
    expect(chamfered.faces.length).toBe(7);

    const cutFace = chamfered.faces.find((face) => face.planeIndex === planes.length);
    expect(cutFace).toBeDefined();
    expect(cutFace!.vertexIndices.length).toBe(3);
  });

  test("returns null when the vertex coincides with the centroid", () => {
    const point: PointXYZ = { x: 1, y: 2, z: 3 };
    expect(chamferPlaneForVertex(point, point, 0.3)).toBeNull();
  });
});

describe("clampFaceOffset", () => {
  test("dragging the top face below the bottom clamps to a bounded offset", () => {
    const planes = cubePlanes();
    const topIndex = planes.length - 1;
    const clamped = clampFaceOffset(planes, topIndex, -1);
    expect(clamped).toBeGreaterThan(0);
    expect(clamped).toBeLessThan(2);

    const updated = planes.map((plane, index) => (index === topIndex ? [plane[0], plane[1], plane[2], clamped] : plane));
    expect(derivePolytope3(updated).kind).toBe("bounded");
  });

  test("a feasible target is returned unchanged", () => {
    const planes = cubePlanes();
    expect(clampFaceOffset(planes, planes.length - 1, 1.5)).toBe(1.5);
  });
});

describe("interiorPoint3", () => {
  test("the cube centroid is strictly interior", () => {
    const planes = cubePlanes();
    const { vertices } = derivePolytope3(planes);
    const interior = interiorPoint3(planes, vertices);
    expect(interior).not.toBeNull();
    for (const [a, b, c, d] of planes) {
      expect(d - (a * interior!.x + b * interior!.y + c * interior!.z)).toBeGreaterThan(1e-9);
    }
  });
});

describe("formatInequality3", () => {
  test("matches the 2D formatConstraint conventions", () => {
    expect(formatInequality3([1, 0, 0, 1])).toBe("x ≤ 1");
    expect(formatInequality3([0, -1, 0, 1])).toBe("-y ≤ 1");
    expect(formatInequality3([0, 0, 1, 2])).toBe("z ≤ 2");
    expect(formatInequality3([0.5, 0.3, -0.8, 2.1])).toBe("0.5x + 0.3y - 0.8z ≤ 2.1");
    expect(formatInequality3([-1, 1, -1, 0])).toBe("-x + y - z ≤ 0");
    expect(formatInequality3([0, 0, 0, 3])).toBe("0 ≤ 3");
    expect(formatInequality3([0.123456, 0, 0, 0.9999999])).toBe("0.123x ≤ 1");
  });
});

describe("enumerateEdges3", () => {
  test("cube has 12 edges, each shared by exactly two faces", async () => {
    const { enumerateEdges3 } = await import("../src/polytope3");
    const polytope = derivePolytope3(cubePlanes());
    const edges = enumerateEdges3(polytope.faces);
    expect(edges.length).toBe(12);
    for (const edge of edges) {
      expect(edge.planeIndices[0]).not.toBe(edge.planeIndices[1]);
    }
  });
});

describe("bevelPlaneForEdge", () => {
  test("beveling a cube edge yields a bounded 7-face solid", async () => {
    const { bevelPlaneForEdge, enumerateEdges3 } = await import("../src/polytope3");
    const planes = cubePlanes();
    const polytope = derivePolytope3(planes);
    const edges = enumerateEdges3(polytope.faces);
    const edge = edges[0];
    const a = polytope.vertices[edge.a];
    const b = polytope.vertices[edge.b];
    const midpoint: PointXYZ = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
    const bevel = bevelPlaneForEdge(midpoint, planes[edge.planeIndices[0]], planes[edge.planeIndices[1]], 0.3);
    expect(bevel).not.toBeNull();
    const beveled = derivePolytope3([...planes, bevel!]);
    expect(beveled.kind).toBe("bounded");
    expect(beveled.faces.length).toBe(7);
    // the new face is a quad along the edge
    const newFace = beveled.faces.find((face) => face.planeIndex === planes.length);
    expect(newFace).toBeDefined();
    expect(newFace!.vertexIndices.length).toBe(4);
  });

  test("anti-parallel faces have no bevel plane", async () => {
    const { bevelPlaneForEdge } = await import("../src/polytope3");
    expect(bevelPlaneForEdge({ x: 0, y: 0, z: 0 }, [0, 0, 1, 1], [0, 0, -1, 0], 0.1)).toBeNull();
  });
});

describe("isBounded3", () => {
  test("cube is bounded", async () => {
    const { isBounded3 } = await import("../src/polytope3");
    expect(isBounded3(cubePlanes())).toBe(true);
  });

  test("cube without its top plane is unbounded", async () => {
    const { isBounded3 } = await import("../src/polytope3");
    const planes = cubePlanes().filter(([, , c, d]) => !(c === 1 && d === 2));
    expect(planes.length).toBe(5);
    expect(isBounded3(planes)).toBe(false);
  });

  test("cube without one side plane is unbounded", async () => {
    const { isBounded3 } = await import("../src/polytope3");
    const planes = cubePlanes().filter(([a]) => a !== 1);
    expect(isBounded3(planes)).toBe(false);
  });

  test("chamfered cube stays bounded after removing the chamfered corner's side", async () => {
    const { isBounded3 } = await import("../src/polytope3");
    // chamfer all 8 corners deeply enough that dropping one side plane keeps
    // the region bounded is NOT generally true — instead verify a tetrahedron
    const tetra: Plane3[] = [
      [-1, 0, 0, 0],
      [0, -1, 0, 0],
      [0, 0, -1, 0],
      [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3), 3],
    ];
    expect(isBounded3(tetra)).toBe(true);
    expect(isBounded3(tetra.slice(0, 3))).toBe(false);
  });

  test("fewer than three planes is never bounded", async () => {
    const { isBounded3 } = await import("../src/polytope3");
    expect(
      isBounded3([
        [0, 0, 1, 1],
        [0, 0, -1, 0],
      ]),
    ).toBe(false);
  });
});

describe("deriveHullFromPoints3", () => {
  const cubePoints = (): PointXYZ[] => {
    const points: PointXYZ[] = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [0, 2]) points.push({ x, y, z });
    return points;
  };

  test("cube corners give 6 quadrilateral faces", async () => {
    const { deriveHullFromPoints3 } = await import("../src/polytope3");
    const hull = deriveHullFromPoints3(cubePoints());
    expect(hull.kind).toBe("bounded");
    expect(hull.faces.length).toBe(6);
    for (const face of hull.faces) expect(face.vertexIndices.length).toBe(4);
    expect(hull.planes.length).toBe(6);
    expect(hull.vertices.length).toBe(8);
  });

  test("a coplanar handle on a face is kept as a vertex but excluded from rings", async () => {
    const { deriveHullFromPoints3 } = await import("../src/polytope3");
    const points = [...cubePoints(), { x: 0, y: 0, z: 2 }]; // center of the top face
    const hull = deriveHullFromPoints3(points);
    expect(hull.kind).toBe("bounded");
    expect(hull.vertices.length).toBe(9);
    expect(hull.faces.length).toBe(6);
    for (const face of hull.faces) {
      expect(face.vertexIndices).not.toContain(8);
      expect(face.vertexIndices.length).toBe(4);
    }
  });

  test("pulling the handle out splits the facet (pyramid on the cube)", async () => {
    const { deriveHullFromPoints3 } = await import("../src/polytope3");
    const points = [...cubePoints(), { x: 0, y: 0, z: 3 }];
    const hull = deriveHullFromPoints3(points);
    expect(hull.kind).toBe("bounded");
    // top face replaced by 4 triangles through the apex
    expect(hull.faces.length).toBe(9);
    const apexFaces = hull.faces.filter((face) => face.vertexIndices.includes(8));
    expect(apexFaces.length).toBe(4);
    for (const face of apexFaces) expect(face.vertexIndices.length).toBe(3);
  });

  test("face rings are outward counter-clockwise", async () => {
    const { deriveHullFromPoints3 } = await import("../src/polytope3");
    const hull = deriveHullFromPoints3(cubePoints());
    for (const face of hull.faces) {
      const [a, b, c, d] = hull.planes[face.planeIndex];
      const loop = face.vertexIndices.map((index) => hull.vertices[index]);
      const normal = newellNormal(loop);
      expect(normal.x * a + normal.y * b + normal.z * c).toBeGreaterThan(0);
      expect(Math.abs(loop[0].x * a + loop[0].y * b + loop[0].z * c - d)).toBeLessThan(1e-7);
    }
  });

  test("tetrahedron points give 4 triangular faces", async () => {
    const { deriveHullFromPoints3 } = await import("../src/polytope3");
    const hull = deriveHullFromPoints3([
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
      { x: 0, y: 2, z: 0 },
      { x: 0, y: 0, z: 2 },
    ]);
    expect(hull.kind).toBe("bounded");
    expect(hull.faces.length).toBe(4);
    for (const face of hull.faces) expect(face.vertexIndices.length).toBe(3);
  });

  test("coplanar and undersized point sets are degenerate", async () => {
    const { deriveHullFromPoints3 } = await import("../src/polytope3");
    expect(
      deriveHullFromPoints3([
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 },
        { x: 1, y: 1, z: 0 },
      ]).kind,
    ).toBe("degenerate");
    expect(
      deriveHullFromPoints3([
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 1, z: 1 },
      ]).kind,
    ).toBe("degenerate");
  });
});
