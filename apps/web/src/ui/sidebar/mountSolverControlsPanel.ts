import type { AppContext } from "@/app/appContext";
import { computeDrawingPhase, getState, on, type SolverMode, type SolverSettings, type State } from "@/features/core/store";
import { el } from "@/ui/dom";
import { isObjectiveDirectionUnbounded } from "@lpviz/polytope/objectiveDirection";
import { hasPolytopeLines } from "@lpviz/polytope/polytopeTypes";
import { buildSolverSection, type SettingsSync } from "./solverSections";

function isSolverSelectable(state: State, mode: SolverMode): boolean {
  if (!hasPolytopeLines(state.polytope)) return false;
  if (state.polytope.kind !== "bounded" && state.polytope.kind !== "unbounded") {
    return false;
  }
  if (mode !== "central" || !state.objectiveVector || state.polytope.kind !== "unbounded") {
    return true;
  }
  return !isObjectiveDirectionUnbounded(state.polytope.lines, [state.objectiveVector.x, state.objectiveVector.y]);
}

export function mountSolverControlsPanel(parent: HTMLElement, ctx: AppContext) {
  const root = el("div", { className: "controlPanel" });
  parent.append(root);
  const buttonGroup = el("div", { className: "button-group" });
  root.append(buttonGroup);
  const buttons = new Map<SolverMode, HTMLButtonElement>();
  const mkButton = (mode: SolverMode, text: string, id?: string) => {
    const b = el("button", { id, text });
    b.addEventListener("click", () => ctx.actions.setActiveSolverMode(mode));
    buttons.set(mode, b);
    buttonGroup.append(b);
  };
  mkButton("ipm", "IPM", "ipmButton");
  mkButton("pdhg", "PDHG");
  mkButton("simplex", "Simplex");
  mkButton("ellipsoid", "Ellipsoid");
  mkButton("central", "Central Path", "iteratePathButton");

  const settings = el("div");
  root.append(settings);

  let renderedMode: SolverMode | null = null;
  let syncSettings: SettingsSync = () => {};

  // every control writes its setting, then re-solves if its solver is the active one
  const set =
    (mode: SolverMode) =>
    <K extends keyof SolverSettings>(key: K) =>
    (v: SolverSettings[K]) => {
      ctx.actions.updateSolverSetting(key, v);
      ctx.actions.recomputeIfModeActive(mode);
    };

  function buildSettings(mode: SolverMode, st: SolverSettings): SettingsSync {
    settings.replaceChildren();
    const sec = el("div", { className: "settings-section is-block" });
    settings.append(sec);
    return buildSolverSection(mode, sec, { st, set: set(mode) });
  }

  function render(s: State) {
    const readyForSolvers = computeDrawingPhase(s) === "ready_for_solvers" && hasPolytopeLines(s.polytope) && s.objectiveVector !== null;
    for (const [mode, b] of buttons) {
      b.className = s.solverMode === mode ? "button-active" : "";
      b.disabled = !readyForSolvers || !isSolverSelectable(s, mode);
    }
    if (renderedMode !== s.solverMode) {
      renderedMode = s.solverMode;
      syncSettings = buildSettings(s.solverMode, s.solverSettings);
    }
    syncSettings(s);
  }

  render(getState());
  const controller = new AbortController();
  on(["solverMode", "solverSettings", "polytope", "vertices", "completionMode", "objectiveVector", "currentObjective"], () => render(getState()), controller.signal);
  return {
    destroy: () => {
      controller.abort();
      root.remove();
    },
  };
}
