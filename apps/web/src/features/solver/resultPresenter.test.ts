import { describe, expect, test } from "bun:test";
import { getState } from "@/features/core/store";
import { createResultPresenter } from "./resultPresenter";
import type { VirtualResultPayload } from "./types";

const run = (count: number): VirtualResultPayload => ({
  type: "virtual",
  header: " Iter        x        y        Obj     Infeas          ρ",
  footer: `Converged in ${count} iterations`,
  rows: {
    length: count,
    at: (index) =>
      index < count
        ? {
            iteration: index + 1,
            x: index,
            y: 0,
            objective: 0,
            infeasibility: 0,
            convergence: 0,
          }
        : undefined,
  },
});

// While the objective rotates, the log shows a window of the run rather than
// all of it. The window must still reach the last row — the iterate the
// viewport stars — and every shown row must keep its own index for hovering.
describe("rotation row window", () => {
  const presenter = createResultPresenter({ getCanvasManager: () => null });
  const shown = () => {
    const rows = getState().resultVirtualRows;
    return Array.from({ length: rows.length }, (_, i) => rows.at(i)!);
  };
  const indices = () => shown().map((block) => block.index);

  test("a short run is shown whole", () => {
    presenter.render(run(12), { limitVirtualRows: true });
    expect(indices()).toEqual([...Array(12).keys()]);
  });

  test("a long run keeps its first and last rows around a gap marker", () => {
    presenter.render(run(50), { limitVirtualRows: true });
    const blocks = shown();
    expect(blocks).toHaveLength(20);
    expect(indices().slice(0, 11)).toEqual([...Array(11).keys()]);
    expect(blocks[11]!.index).toBeUndefined();
    expect(blocks[11]!.className).toBe("iterate-item-nohover");
    expect(blocks[11]!.text).toContain("31 iterations not shown");
    expect(indices().slice(12)).toEqual([42, 43, 44, 45, 46, 47, 48, 49]);
    expect(blocks[19]!.text.trimStart().startsWith("50 ")).toBe(true);
  });

  test("the whole run comes back once the limit is lifted", () => {
    presenter.render(run(50), { limitVirtualRows: true });
    presenter.render(run(50), { limitVirtualRows: false });
    expect(getState().resultVirtualRows.length).toBe(50);
    expect(indices()[49]).toBe(49);
  });
});
