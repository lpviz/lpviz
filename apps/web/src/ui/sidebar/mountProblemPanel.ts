import type { AppActions } from "@/app/appActions";
import type { State } from "@/features/core/store";
import { el } from "@/ui/dom";
import { renderOn } from "@/ui/renderOn";
import { NULL_STATE_LOGO_SVG } from "@/ui/logo";
import { hasObjective, hasRegion, READY_FOR_SOLVERS_KEYS } from "@/features/problem/selectors";
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

export function mountProblemPanel(parent: HTMLElement, actions: Pick<AppActions, "setConstraintHighlight">) {
  const frame = el("div", { id: "terminal-container2" });
  const topResult = el("div", { id: "topResult" });
  const nullState = el("div", { id: "nullStateMessage", attrs: { role: "img", "aria-label": "lpviz logo" }, html: NULL_STATE_LOGO_SVG });
  const maximize = el("div", { id: "maximize", text: "maximize" });
  const objective = el("div", { id: "objectiveDisplay" });
  const subjectTo = el("div", { id: "subjectTo", text: "subject to" });
  // delegated hover handlers: rows are rebuilt on every polytope change, so
  // per-row listeners would be re-created each time
  const inequalities = el("div", {
    id: "inequalities",
    on: {
      mouseover: (e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>(".inequality-item");
        if (row?.dataset.index !== undefined) actions.setConstraintHighlight(Number(row.dataset.index));
      },
      mouseleave: () => actions.setConstraintHighlight(null),
    },
  });
  topResult.append(nullState, maximize, objective, subjectTo, inequalities);
  frame.append(topResult, el("div", { id: "terminal-window" }));
  parent.append(frame);
  let lastItemsKey: unknown[] | null = null;
  function render(state: State) {
    const objectiveActive = hasObjective(state);
    nullState.hidden = !(state.vertices.length === 0 && state.objectiveVector === null && state.currentObjective === null);
    maximize.hidden = !(state.completionMode !== "draft" && objectiveActive);
    objective.classList.toggle("objective-item", objectiveActive);
    objective.classList.toggle("objective-active", objectiveActive);
    objective.textContent = formatObjectiveDisplay(state.objectiveVector);
    subjectTo.hidden = !hasRegion(state);

    // objective-only updates (every rotation step) must not rebuild the
    // constraint rows; rebuild only when their source actually changed
    const itemsKey: unknown[] = [state.polytope?.constraints, state.completionMode, state.inequalitiesMessage];
    const previousKey = lastItemsKey;
    if (previousKey && itemsKey.every((value, i) => Object.is(value, previousKey[i]))) return;
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
  const stopRender = renderOn([...READY_FOR_SOLVERS_KEYS, "inequalitiesMessage"], render);
  return {
    destroy: () => {
      stopRender();
      frame.remove();
    },
  };
}
