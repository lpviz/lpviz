import type { AppContext } from "@/app/appContext";
import type { State } from "@/features/core/store";
import { SOLVER_LABELS, type SolverMode, type SolverSettings } from "@/features/solver/solverSettings";
import { isReadyForSolvers, isSolverSelectable } from "@/features/problem/selectors";
import { button, el } from "@/ui/dom";
import { renderOn } from "@/ui/renderOn";
import { buildSolverSection, type SettingsSync } from "./solverSections";

export function mountSolverControlsPanel(parent: HTMLElement, ctx: AppContext) {
  const root = el("div", { className: "controlPanel" });
  parent.append(root);
  const buttonGroup = el("div", { className: "button-group" });
  root.append(buttonGroup);
  const buttons = new Map<SolverMode, HTMLButtonElement>();
  // the panel's order, the general-purpose solvers first
  for (const mode of ["ipm", "pdhg", "simplex", "ellipsoid", "central"] as const) {
    const b = button(SOLVER_LABELS[mode], () => ctx.actions.setActiveSolverMode(mode), { id: `${mode}Button` });
    buttons.set(mode, b);
    buttonGroup.append(b);
  }

  const settings = el("div");
  root.append(settings);

  let renderedMode: SolverMode | null = null;
  let syncSettings: SettingsSync = () => {};

  function buildSettings(mode: SolverMode, st: SolverSettings): SettingsSync {
    settings.replaceChildren();
    const sec = el("div", { className: "settings-section is-block" });
    settings.append(sec);
    // every control writes its setting, then re-solves if its solver is the active one
    return buildSolverSection(mode, sec, {
      st,
      set: (key) => (v) => {
        ctx.actions.updateSolverSetting(key, v);
        ctx.actions.recomputeIfModeActive(mode);
      },
    });
  }

  function render(s: State) {
    const readyForSolvers = isReadyForSolvers(s);
    for (const [mode, b] of buttons) {
      b.className = s.solverMode === mode ? "button-active" : "";
      b.disabled = !readyForSolvers || !isSolverSelectable(s, mode);
    }
    if (renderedMode !== s.solverMode) {
      renderedMode = s.solverMode;
      syncSettings = buildSettings(s.solverMode, s.solverSettings);
    }
    syncSettings(s.solverSettings);
  }

  const stopRender = renderOn(["solverMode", "solverSettings", "polytope", "vertices", "completionMode", "objectiveVector", "currentObjective"], render);
  return {
    destroy: () => {
      stopRender();
      root.remove();
    },
  };
}
