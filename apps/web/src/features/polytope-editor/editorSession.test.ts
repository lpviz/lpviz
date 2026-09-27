import { describe, expect, test } from "bun:test";
import type { State } from "@/features/core/store";
import type { PointXY } from "@lpviz/math/types";
import {
  computeEditorRegionForState,
  getEditorContext,
  getEditorTransition,
} from "./editorSession";

// Characterization tests for the pure editor FSM. These pin today's behavior so
// the Phase 4 interaction rework (routing drags through getEditorTransition) is
// provably behavior-preserving. getEditorTransition reads only a handful of
// State fields, so a minimal fixture suffices.
function st(o: Partial<State>): State {
  return {
    vertices: [],
    completionMode: "draft",
    currentObjective: null,
    objectiveVector: null,
    polytope: null,
    interiorPoint: null,
    editorInteraction: { kind: "idle" },
    ...o,
  } as unknown as State;
}

const TRI = [
  { x: 0, y: 0 },
  { x: 4, y: 0 },
  { x: 2, y: 3 },
];

describe("getEditorContext.session", () => {
  test("empty/sketching → drafting", () => {
    expect(getEditorContext(st({})).session.kind).toBe("drafting");
    expect(getEditorContext(st({ vertices: TRI })).session.kind).toBe(
      "drafting",
    );
  });
  test("finished region, no objective → selecting-objective", () => {
    expect(
      getEditorContext(st({ vertices: TRI, completionMode: "closed" })).session
        .kind,
    ).toBe("selecting-objective");
  });
  test("closed with objective → editing-closed", () => {
    expect(
      getEditorContext(
        st({
          vertices: TRI,
          completionMode: "closed",
          objectiveVector: { x: 1, y: 0 },
        }),
      ).session.kind,
    ).toBe("editing-closed");
  });
});

describe("getEditorTransition: click", () => {
  test("first click adds a draft vertex", () => {
    const t = getEditorTransition(st({}), {
      kind: "click",
      point: { x: 1, y: 2 },
    });
    expect(t).toEqual({
      kind: "edit",
      result: {
        vertices: [{ x: 1, y: 2 }],
        completionMode: "draft",
        interiorPoint: null,
      },
      saveToHistory: true,
    });
  });

  test("click near first vertex of a triangle closes it (centroid interior)", () => {
    const t = getEditorTransition(st({ vertices: TRI }), {
      kind: "click",
      point: { x: 0.2, y: 0.1 },
    });
    expect(t.kind).toBe("edit");
    if (t.kind !== "edit") throw new Error();
    expect(t.result.completionMode).toBe("closed");
    expect(t.result.interiorPoint).toEqual({ x: 2, y: 1 });
  });

  test("click strictly inside a triangle closes with the clicked interior point", () => {
    const t = getEditorTransition(st({ vertices: TRI }), {
      kind: "click",
      point: { x: 2.5, y: 1 },
    });
    expect(t.kind).toBe("edit");
    if (t.kind !== "edit") throw new Error();
    expect(t.result.completionMode).toBe("closed");
    expect(t.result.interiorPoint).toEqual({ x: 2.5, y: 1 });
  });

  test("click that would make a non-convex polygon is rejected", () => {
    const t = getEditorTransition(st({ vertices: [...TRI] }), {
      kind: "click",
      point: { x: -1, y: -1 },
    });
    expect(t.kind).toBe("reject-nonconvex");
    // the reason now travels with the transition (callers no longer hardcode it)
    if (t.kind === "reject-nonconvex")
      expect(t.reason).toContain("nonconvex");
  });

  test("click while selecting objective picks the objective", () => {
    const t = getEditorTransition(
      st({ vertices: TRI, completionMode: "closed" }),
      { kind: "click", point: { x: 3, y: 2 } },
    );
    expect(t).toEqual({
      kind: "select-objective",
      objectiveVector: { x: 3, y: 2 },
      saveToHistory: true,
    });
  });

  test("click in editing-closed (objective set) is a noop", () => {
    const t = getEditorTransition(
      st({
        vertices: TRI,
        completionMode: "closed",
        objectiveVector: { x: 1, y: 0 },
      }),
      { kind: "click", point: { x: 9, y: 9 } },
    );
    expect(t.kind).toBe("noop");
  });
});

describe("getEditorTransition: finish-open", () => {
  test("fewer than 2 vertices is a noop", () => {
    expect(
      getEditorTransition(st({ vertices: [{ x: 0, y: 0 }] }), {
        kind: "finish-open",
      }).kind,
    ).toBe("noop");
  });
  test("convex chain finishes as an open region", () => {
    const t = getEditorTransition(
      st({
        vertices: [
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 6, y: 3 },
        ],
      }),
      { kind: "finish-open" },
    );
    expect(t.kind).toBe("edit");
    if (t.kind !== "edit") throw new Error();
    expect(t.result.completionMode).toBe("open");
  });
  test("non-convex chain is rejected", () => {
    const t = getEditorTransition(
      st({
        vertices: [
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 2, y: 1 },
          { x: 6, y: 0 },
        ],
      }),
      { kind: "finish-open" },
    );
    expect(t.kind).toBe("reject-nonconvex");
    if (t.kind === "reject-nonconvex")
      expect(t.reason).toContain("nonconvex");
  });
});

describe("getEditorTransition: delete-vertex", () => {
  test("drafting delete removes the vertex, stays draft", () => {
    const t = getEditorTransition(
      st({
        vertices: [
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 2, y: 3 },
        ],
      }),
      { kind: "delete-vertex", deleteIndex: 1 },
    );
    expect(t.kind).toBe("edit");
    if (t.kind !== "edit") throw new Error();
    expect(t.result.vertices).toEqual([
      { x: 0, y: 0 },
      { x: 2, y: 3 },
    ]);
    expect(t.result.completionMode).toBe("draft");
  });

  const PENT = [0, 1, 2, 3, 4].map((i) => ({
    x: +(10 * Math.cos((2 * Math.PI * i) / 5)).toFixed(3),
    y: +(10 * Math.sin((2 * Math.PI * i) / 5)).toFixed(3),
  }));
  const closedPentagon = (objectiveVector: PointXY | null) =>
    st({
      vertices: PENT,
      completionMode: "closed",
      interiorPoint: { x: 0, y: 0 },
      objectiveVector,
    });

  test("a closed polygon loses just that vertex and stays closed", () => {
    for (const objective of [{ x: 1, y: 0 }, null]) {
      const t = getEditorTransition(closedPentagon(objective), {
        kind: "delete-vertex",
        deleteIndex: 1,
      });
      expect(t.kind).toBe("edit");
      if (t.kind !== "edit") throw new Error();
      expect(t.result.vertices).toEqual([PENT[0], PENT[2], PENT[3], PENT[4]]);
      expect(t.result.completionMode).toBe("closed");
      expect(t.result.interiorPoint).not.toBeNull();
    }
  });

  // Regression: deleting used to reopen the polygon into a chain, dropping the
  // two edges at the vertex. Whenever the remaining edges still bounded a
  // region (any pentagon after an insert, most larger polygons always), the
  // open-region promotion re-closed it with the deleted vertex's neighbours
  // replaced by the crossing of their edges, so one right-click took three
  // vertices and bulged the polygon out.
  test("inserting a vertex on an edge and deleting it is a round trip", () => {
    const objectiveVector = { x: 1, y: 0 };
    const inserted = getEditorTransition(closedPentagon(objectiveVector), {
      kind: "insert-edge-point",
      edgeIndex: 0,
      point: {
        x: (PENT[0].x + PENT[1].x) / 2,
        y: (PENT[0].y + PENT[1].y) / 2,
      },
    });
    if (inserted.kind !== "edit") throw new Error(inserted.kind);
    expect(inserted.result.vertices).toHaveLength(6);

    const deleted = getEditorTransition(
      st({ ...inserted.result, objectiveVector }),
      { kind: "delete-vertex", deleteIndex: 1 },
    );
    if (deleted.kind !== "edit") throw new Error(deleted.kind);
    expect(deleted.result.vertices).toEqual(PENT);
    expect(deleted.result.completionMode).toBe("closed");

    const region = computeEditorRegionForState(
      st({ ...deleted.result, objectiveVector }),
    );
    expect(region.status).toBe("ready");
    if (region.status !== "ready") throw new Error();
    expect(region.polytope.kind).toBe("bounded");
    expect(region.polytope.vertices).toHaveLength(5);
    expect(region.promotion).toBeNull();
  });

  test("deleting a triangle's vertex goes back to drafting the other two", () => {
    const t = getEditorTransition(
      st({
        vertices: TRI,
        completionMode: "closed",
        interiorPoint: { x: 2, y: 1 },
        objectiveVector: { x: 1, y: 0 },
      }),
      { kind: "delete-vertex", deleteIndex: 2 },
    );
    if (t.kind !== "edit") throw new Error(t.kind);
    expect(t.result.vertices).toEqual([TRI[0], TRI[1]]);
    expect(t.result.completionMode).toBe("draft");
    expect(t.result.interiorPoint).toBeNull();
  });

  test("an open chain loses the vertex and stays open", () => {
    const chain = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 6, y: 3 },
      { x: 6, y: 8 },
    ];
    const t = getEditorTransition(
      st({
        vertices: chain,
        completionMode: "open",
        objectiveVector: { x: 1, y: 0 },
      }),
      { kind: "delete-vertex", deleteIndex: 1 },
    );
    if (t.kind !== "edit") throw new Error(t.kind);
    expect(t.result.vertices).toEqual([chain[0], chain[2], chain[3]]);
    expect(t.result.completionMode).toBe("open");
  });
});

describe("computeEditorRegionForState", () => {
  // the vertices of a regular pentagon visited every second one: every turn
  // agrees, the boundary winds twice around the center
  const PENTAGRAM = [0, 2, 4, 1, 3].map((i) => ({
    x: 10 * Math.cos((2 * Math.PI * i) / 5),
    y: 10 * Math.sin((2 * Math.PI * i) / 5),
  }));

  test("a self-overlapping closed polygon is nonconvex, not a region", () => {
    const result = computeEditorRegionForState(
      st({
        vertices: PENTAGRAM,
        completionMode: "closed",
        interiorPoint: { x: 0, y: 0 },
        objectiveVector: { x: 1, y: 0 },
      }),
    );
    expect(result.status).toBe("nonconvex");
  });

  // an open region's end dragged past the point where its rays cross: the
  // chain overshoots the closed region it now bounds, and is trimmed to it on
  // release rather than flagged — so it must still count as a valid chain
  test("an open chain that closes on itself is still a region", () => {
    const result = computeEditorRegionForState(
      st({
        vertices: [
          { x: -6.125, y: 10.1875 },
          { x: -12.175, y: 8.1875 },
          { x: -0.925, y: 14.6875 },
          { x: 10.275, y: 9.8375 },
        ],
        completionMode: "open",
        objectiveVector: { x: 1, y: 0 },
      }),
    );
    expect(result.status).toBe("ready");
  });

  test("a convex triangle is a region", () => {
    const result = computeEditorRegionForState(
      st({
        vertices: TRI,
        completionMode: "closed",
        interiorPoint: { x: 2, y: 1 },
        objectiveVector: { x: 1, y: 0 },
      }),
    );
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.polytope.inequalities).toHaveLength(3);
    }
  });
});
