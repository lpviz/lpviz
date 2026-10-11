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

  const settingsSlot = el("div");
  root.append(settingsSlot);

  let renderedMode: SolverMode | null = null;
  let syncSettings: SettingsSync = () => {};

  function buildSettings(mode: SolverMode, settings: SolverSettings): SettingsSync {
    settingsSlot.replaceChildren();
    const sec = el("div", { className: "settings-section is-block" });
    settingsSlot.append(sec);
    // every control writes its setting, then re-solves if its solver is the active one
    return buildSolverSection(mode, sec, {
      settings,
      set: (key) => (v) => {
        ctx.actions.updateSolverSetting(key, v);
        ctx.actions.recomputeIfModeActive(mode);
      },
    });
  }

  function render(state: State) {
    const readyForSolvers = isReadyForSolvers(state);
    for (const [mode, b] of buttons) {
      b.className = state.solverMode === mode ? "button-active" : "";
      b.disabled = !readyForSolvers || !isSolverSelectable(state, mode);
    }
    if (renderedMode !== state.solverMode) {
      renderedMode = state.solverMode;
      syncSettings = buildSettings(state.solverMode, state.solverSettings);
    }
    syncSettings(state.solverSettings);
  }

  const stopRender = renderOn(["solverMode", "solverSettings", "polytope", "vertices", "completionMode", "objectiveVector", "currentObjective"], render);
  return {
    destroy: () => {
      stopRender();
      root.remove();
    },
  };
}
