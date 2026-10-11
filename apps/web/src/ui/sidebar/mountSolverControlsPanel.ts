import type { AppActions } from "@/app/appActions";
import type { State } from "@/features/core/store";
import { SOLVER_LABELS, type SolverMode } from "@/features/solver/solverSettings";
import { isReadyForSolvers, isSolverSelectable, READY_FOR_SOLVERS_KEYS } from "@/features/problem/selectors";
import { button, el } from "@/ui/dom";
import { renderOn } from "@/ui/renderOn";
import { buildSolverSection, type SettingsSync } from "./solverSections";

export function mountSolverControlsPanel(parent: HTMLElement, actions: Pick<AppActions, "setActiveSolverMode" | "updateSolverSetting" | "recomputeIfModeActive">) {
  const root = el("div", { className: "controlPanel" });
  parent.append(root);
  const buttonGroup = el("div", { className: "button-group" });
  root.append(buttonGroup);
  const buttons = new Map<SolverMode, HTMLButtonElement>();
  // the panel's order, the general-purpose solvers first
  for (const mode of ["ipm", "pdhg", "simplex", "ellipsoid", "central"] as const) {
    const b = button(SOLVER_LABELS[mode], () => actions.setActiveSolverMode(mode), { id: `${mode}Button` });
    buttons.set(mode, b);
    buttonGroup.append(b);
  }

  const settingsSlot = el("div");
  root.append(settingsSlot);

  let renderedMode: SolverMode | null = null;
  let syncSettings: SettingsSync = () => {};

  // the controls, synced from the settings by the caller; every control writes its setting, then
  // re-solves if its solver is the active one
  function buildSettings(mode: SolverMode): SettingsSync {
    settingsSlot.replaceChildren();
    const sec = el("div", { className: "settings-section" });
    settingsSlot.append(sec);
    return buildSolverSection(mode, sec, {
      set: (key) => (v) => {
        actions.updateSolverSetting(key, v);
        actions.recomputeIfModeActive(mode);
      },
    });
  }

  function render(state: State) {
    const readyForSolvers = isReadyForSolvers(state);
    for (const [mode, b] of buttons) {
      b.classList.toggle("button-active", state.solverMode === mode);
      b.disabled = !readyForSolvers || !isSolverSelectable(state, mode);
    }
    if (renderedMode !== state.solverMode) {
      renderedMode = state.solverMode;
      syncSettings = buildSettings(state.solverMode);
    }
    syncSettings(state.solverSettings);
  }

  const stopRender = renderOn(["solverMode", "solverSettings", ...READY_FOR_SOLVERS_KEYS], render);
  return {
    destroy: () => {
      stopRender();
      root.remove();
    },
  };
}
