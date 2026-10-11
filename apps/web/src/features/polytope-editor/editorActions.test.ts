import { describe, expect, test } from "bun:test";
import type { State } from "@/features/core/store";
import type { Constraint, Vec } from "@lpviz/math/types";
import { dragPatch } from "./editorActions";
import type { DragTarget } from "./editorState";

type ConstraintDragOperation = Extract<DragTarget, { kind: "constraint" }>["operation"];

// What a drag does to the store for each thing it can hold; the arithmetic of a constraint drag
// (the pointer's travel along the normal moves the whole line) is the part worth pinning.
const SQUARE: Vec[] = [
  [0, 0],
  [4, 0],
  [4, 4],
  [0, 4],
];
// the square as a·x ≤ b
const SQUARE_LINES: Constraint[] = [
  [1, 0, 4],
  [0, 1, 4],
  [-1, 0, 0],
  [0, -1, 0],
];
const drawn = { vertices: SQUARE } as State;
// the rebuilt vertices come back as a set, with -0 where a line solves to it
const sorted = (points: readonly Vec[]) => [...points].map((p) => [...p].map((c) => c + 0)).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);

describe("dragPatch", () => {
  test("a point drag moves that vertex", () => {
    expect(dragPatch({ kind: "point", index: 2 }, [5, 5], drawn)).toEqual({
      vertices: [
        [0, 0],
        [4, 0],
        [5, 5],
        [0, 4],
      ],
    });
  });

  test("an open region's edge drag moves its two vertices by the pointer's travel along the normal, and continues from the pointer", () => {
    const operation: ConstraintDragOperation = { kind: "open-vertices", vertexIndices: [1, 2] };
    expect(dragPatch({ kind: "constraint", operation, start: [4, 2], normal: [1, 0] }, [6, 3], drawn)).toEqual({
      vertices: [
        [0, 0],
        [6, 0],
        [6, 4],
        [0, 4],
      ],
      editorInteraction: { kind: "dragging", target: { kind: "constraint", operation, start: [6, 3], normal: [1, 0] } },
    });
  });

  test("a closed region's edge drag shifts the line and rebuilds the vertices from the lines", () => {
    const patch = dragPatch({ kind: "constraint", operation: { kind: "closed-line", lineIndex: 0, constraints: SQUARE_LINES }, start: [4, 2], normal: [1, 0] }, [6, 2], drawn)!;
    expect(sorted(patch.vertices!)).toEqual(
      sorted([
        [0, 0],
        [6, 0],
        [6, 4],
        [0, 4],
      ]),
    );
    const interaction = patch.editorInteraction!;
    if (interaction.kind !== "dragging" || interaction.target.kind !== "constraint" || interaction.target.operation.kind !== "closed-line") throw new Error("expected a closed-line drag");
    expect(interaction.target.operation.constraints[0]).toEqual([1, 0, 6]);
  });

  test("a closed region's edge dragged past the region leaves it where it was", () => {
    expect(dragPatch({ kind: "constraint", operation: { kind: "closed-line", lineIndex: 0, constraints: SQUARE_LINES }, start: [4, 2], normal: [1, 0] }, [-1, 2], drawn)).toBeNull();
  });

  test("the start marker keeps the offset it was grabbed at", () => {
    expect(dragPatch({ kind: "solver-start", grabOffset: [1, -1] }, [2, 2], drawn)).toEqual({ solverStartPoint: [3, 1] });
    expect(dragPatch({ kind: "solver-start" }, [2, 2], drawn)).toEqual({ solverStartPoint: [2, 2] });
  });

  test("the objective follows the pointer", () => {
    expect(dragPatch({ kind: "objective" }, [1, 2], drawn)).toEqual({ objectiveVector: [1, 2] });
  });
});
