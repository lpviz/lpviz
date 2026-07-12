import type { AppContext } from "@/app/appContext";
import { getState, on, type State } from "@/features/core/store";
import { clear, el } from "@/ui/dom";
import { renderNullStateLogo } from "@/ui/logo";
import { hasPolytopeLines } from "@lpviz/polytope/polytopeTypes";

function formatObjectiveDisplay(objectiveVector: State["objectiveVector"]): string {
  if (!objectiveVector) return "";
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const a = round(objectiveVector.x);
  const b = round(objectiveVector.y);
  const bTerm = b >= 0 ? `+ ${b}y` : `- ${-b}y`;
  return `${a}x ${bTerm}`;
}

function formatObjective3Display(objectiveVector3: State["objectiveVector3"]): string {
  if (!objectiveVector3) return "";
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const a = round(objectiveVector3.x);
  const b = round(objectiveVector3.y);
  const c = round(objectiveVector3.z);
  const signTerm = (value: number, name: string) => (value >= 0 ? `+ ${value}${name}` : `- ${-value}${name}`);
  return `${a}x ${signTerm(b, "y")} ${signTerm(c, "z")}`;
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
  frame.append(topResult, el("div", { id: "terminal-window" }), el("div", { className: "scanlines" }), el("div", { className: "scanlines scanlines--delay-8" }));
  parent.append(frame);
  function render(state: State) {
    // once the 3-variable editor has a solid, the panel shows the 3D problem
    // (during the sketch phase it shows the in-progress 2D base constraints)
    const solid3D = state.problemMode === "3d" && state.editor3Phase !== "sketch" && state.polytope3 !== null;
    const objectiveActive = solid3D ? state.objectiveVector3 !== null : state.objectiveVector !== null;
    nullState.style.display = state.vertices.length === 0 && state.objectiveVector === null && state.currentObjective === null && !solid3D ? "" : "none";
    maximize.className = (solid3D || state.completionMode !== "draft") && objectiveActive ? "is-block" : "is-hidden";
    objective.className = objectiveActive ? "objective-item objective-active" : "";
    objective.textContent = solid3D ? formatObjective3Display(state.objectiveVector3) : formatObjectiveDisplay(state.objectiveVector);
    subjectTo.className = solid3D ? (state.polytope3!.inequalities.length > 0 ? "is-block" : "is-hidden") : hasPolytopeLines(state.polytope) && state.polytope.lines.length > 0 ? "is-block" : "is-hidden";

    // objective-only updates (every rotation step) must not rebuild the
    // constraint rows; rebuild only when their source actually changed
    const itemsKey: unknown[] = [state.polytope?.inequalities, state.completionMode, state.inequalitiesMessage, solid3D ? state.polytope3 : null];
    if (lastItemsKey && itemsKey.every((value, i) => Object.is(value, lastItemsKey![i]))) {
      return;
    }
    lastItemsKey = itemsKey;

    clear(inequalities);
    if (solid3D) {
      state.polytope3!.inequalities.forEach((text, index) => {
        inequalities.append(
          el("div", {
            className: "inequality-item",
            text,
            attrs: { "data-index": String(index) },
          }),
        );
      });
      return;
    }
    if (state.inequalitiesMessage !== null) {
      inequalities.textContent = state.inequalitiesMessage;
      return;
    }
    if (!state.polytope) return;
    const items = state.completionMode === "draft" ? state.polytope.inequalities.slice(0, Math.max(0, state.polytope.inequalities.length - 1)) : state.polytope.inequalities;
    items.forEach((text, index) => {
      inequalities.append(
        el("div", {
          className: "inequality-item",
          text,
          attrs: { "data-index": String(index) },
        }),
      );
    });
  }
  let lastItemsKey: unknown[] | null = null;
  render(getState());
  const controller = new AbortController();
  on(["completionMode", "objectiveVector", "currentObjective", "vertices", "polytope", "inequalitiesMessage", "polytope3", "objectiveVector3", "editor3Phase"], () => render(getState()), controller.signal);
  return {
    topResult,
    destroy: () => {
      controller.abort();
      frame.remove();
    },
  };
}
