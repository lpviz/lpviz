import type { AppContext } from "@/app/appContext";
import { getState, on, type State } from "@/features/core/store";
import { el } from "@/ui/dom";
import { renderNullStateLogo } from "@/ui/logo";
import { hasObjective, hasRegion } from "@/features/problem/selectors";
import { formatConstraint } from "@lpviz/polytope/constraints";

const VARIABLE_NAMES = ["x", "y", "z"];

// "7x + 3y", or "1x - 2y + 3z" for three variables: one term per coefficient, rounded to three decimals
function formatObjectiveDisplay(objectiveVector: State["objectiveVector"]): string {
  if (!objectiveVector) return "";
  return objectiveVector
    .map((coefficient, j) => {
      const value = Math.round(coefficient * 1000) / 1000;
      const name = VARIABLE_NAMES[j] ?? `x${j + 1}`;
      if (j === 0) return `${value}${name}`;
      return value >= 0 ? `+ ${value}${name}` : `- ${-value}${name}`;
    })
    .join(" ");
}

export function mountProblemPanel(parent: HTMLElement, ctx: AppContext) {
  const frame = el("div", { id: "terminal-container2" });
  const topResult = el("div", { id: "topResult" });
  const nullState = el("div", {
    id: "nullStateMessage",
    attrs: { role: "img", "aria-label": "lpviz logo" },
  });
  renderNullStateLogo(nullState);
  const maximize = el("div", { id: "maximize", text: "maximize" });
  const objective = el("div", { id: "objectiveDisplay" });
  const subjectTo = el("div", { id: "subjectTo", text: "subject to" });
  const inequalities = el("div", { id: "inequalities" });
  topResult.append(nullState, maximize, objective, subjectTo, inequalities);
  // delegated hover handlers: rows are rebuilt on every polytope change, so
  // per-row listeners would be re-created each time
  inequalities.addEventListener("mouseover", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".inequality-item");
    if (row?.dataset.index !== undefined) {
      ctx.actions.setConstraintHighlight(Number(row.dataset.index));
    }
  });
  inequalities.addEventListener("mouseleave", () => ctx.actions.setConstraintHighlight(null));
  frame.append(topResult, el("div", { id: "terminal-window" }));
  parent.append(frame);
  function render(state: State) {
    const objectiveActive = hasObjective(state);
    nullState.style.display = state.vertices.length === 0 && state.objectiveVector === null && state.currentObjective === null ? "" : "none";
    maximize.className = state.completionMode !== "draft" && objectiveActive ? "is-block" : "is-hidden";
    objective.className = objectiveActive ? "objective-item objective-active" : "";
    objective.textContent = formatObjectiveDisplay(state.objectiveVector);
    subjectTo.className = hasRegion(state) ? "is-block" : "is-hidden";

    // objective-only updates (every rotation step) must not rebuild the
    // constraint rows; rebuild only when their source actually changed
    const itemsKey: unknown[] = [state.polytope?.constraints, state.completionMode, state.inequalitiesMessage];
    if (lastItemsKey && itemsKey.every((value, i) => Object.is(value, lastItemsKey![i]))) {
      return;
    }
    lastItemsKey = itemsKey;

    inequalities.replaceChildren();
    if (state.inequalitiesMessage !== null) {
      inequalities.textContent = state.inequalitiesMessage;
      return;
    }
    if (!state.polytope) return;
    const { constraints } = state.polytope;
    // while drafting, the closing edge is not drawn yet, so its constraint is not listed either
    const listed = state.completionMode === "draft" ? constraints.slice(0, Math.max(0, constraints.length - 1)) : constraints;
    listed.forEach((constraint, index) => {
      inequalities.append(
        el("div", {
          className: "inequality-item",
          text: formatConstraint(constraint),
          attrs: { "data-index": String(index) },
        }),
      );
    });
  }
  let lastItemsKey: unknown[] | null = null;
  render(getState());
  const controller = new AbortController();
  on(["completionMode", "objectiveVector", "currentObjective", "vertices", "polytope", "inequalitiesMessage"], () => render(getState()), controller.signal);
  return {
    topResult,
    destroy: () => {
      controller.abort();
      frame.remove();
    },
  };
}
