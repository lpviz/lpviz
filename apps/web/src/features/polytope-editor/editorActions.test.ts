import { describe, expect, test } from "bun:test";
import { getState, setState } from "@/features/core/store";
import type { Constraint, Vec } from "@lpviz/math/types";
import { applyDragTarget } from "./editorActions";
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
// the rebuilt vertices come back as a set, with -0 where a line solves to it
const sorted = (points: readonly Vec[]) => [...points].map((p) => [...p].map((c) => c + 0)).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);

function deps() {
  const counts = { derived: 0, moved: 0 };
  return { counts, derivePolytope: () => void counts.derived++, onSolverStartMoved: () => void counts.moved++ };
}
const reset = () => setState({ vertices: SQUARE, editorInteraction: { kind: "idle" }, solverStartPoint: null, objectiveVector: null });

describe("applyDragTarget", () => {
  test("a point drag moves that vertex and re-derives", () => {
    reset();
    const d = deps();
    applyDragTarget({ kind: "point", index: 2 }, [5, 5], d);
    expect(getState().vertices[2]).toEqual([5, 5]);
    expect(d.counts).toEqual({ derived: 1, moved: 0 });
  });

  test("an open region's edge drag moves its two vertices by the pointer's travel along the normal", () => {
    reset();
    const d = deps();
    const operation: ConstraintDragOperation = { kind: "open-vertices", vertexIndices: [1, 2] };
    applyDragTarget({ kind: "constraint", operation, start: [4, 2], normal: [1, 0] }, [6, 3], d);
    expect(getState().vertices).toEqual([
      [0, 0],
      [6, 0],
      [6, 4],
      [0, 4],
    ]);
    // the drag continues from the new pointer position
    expect(getState().editorInteraction).toEqual({ kind: "dragging", target: { kind: "constraint", operation, start: [6, 3], normal: [1, 0] } });
    expect(d.counts.derived).toBe(1);
  });

  test("a closed region's edge drag shifts the line and rebuilds the vertices from the lines", () => {
    reset();
    const d = deps();
    applyDragTarget({ kind: "constraint", operation: { kind: "closed-line", lineIndex: 0, constraints: SQUARE_LINES }, start: [4, 2], normal: [1, 0] }, [6, 2], d);
    expect(sorted(getState().vertices)).toEqual(
      sorted([
        [0, 0],
        [6, 0],
        [6, 4],
        [0, 4],
      ]),
    );
    const interaction = getState().editorInteraction;
    if (interaction.kind !== "dragging" || interaction.target.kind !== "constraint" || interaction.target.operation.kind !== "closed-line") throw new Error("expected a closed-line drag");
    expect(interaction.target.operation.constraints[0]).toEqual([1, 0, 6]);
    expect(d.counts.derived).toBe(1);
  });

  test("a closed region's edge dragged past the region is left where it was", () => {
    reset();
    const d = deps();
    applyDragTarget({ kind: "constraint", operation: { kind: "closed-line", lineIndex: 0, constraints: SQUARE_LINES }, start: [4, 2], normal: [1, 0] }, [-1, 2], d);
    expect(getState().vertices).toEqual(SQUARE);
    expect(getState().editorInteraction).toEqual({ kind: "idle" });
    expect(d.counts.derived).toBe(0);
  });

  test("the start marker keeps the offset it was grabbed at, and does not re-derive", () => {
    reset();
    const d = deps();
    applyDragTarget({ kind: "solver-start", grabOffset: [1, -1] }, [2, 2], d);
    expect(getState().solverStartPoint).toEqual([3, 1]);
    applyDragTarget({ kind: "solver-start" }, [2, 2], d);
    expect(getState().solverStartPoint).toEqual([2, 2]);
    expect(d.counts).toEqual({ derived: 0, moved: 2 });
  });

  test("the objective follows the pointer", () => {
    reset();
    const d = deps();
    applyDragTarget({ kind: "objective" }, [1, 2], d);
    expect(getState().objectiveVector).toEqual([1, 2]);
    expect(d.counts.derived).toBe(1);
  });
});
