import { settingRange } from "@/features/solver/solverSettings";
import type { AppActions } from "@/app/appActions";
import type { State } from "@/features/core/store";
import { hasObjective, hasRegion } from "@/features/problem/selectors";
import { button, checkbox, el, range } from "@/ui/dom";
import { renderOn } from "@/ui/renderOn";

export function mountAnimationControlsPanel(parent: HTMLElement, actions: Pick<AppActions, "toggleReplay" | "startRotation" | "stopMotion" | "updateSolverSetting" | "setTraceEnabled">) {
  const root = el("div", { className: "controlPanel controlPanel--compact" });
  parent.append(root);
  const animate = button("Animate", () => actions.toggleReplay());
  const start = button("Rotate Objective", () => actions.startRotation());
  const stop = button("Stop Rotation", () => actions.stopMotion());
  root.append(el("div", { className: "button-group" }, [animate]), el("div", { className: "button-group" }, [start, stop]));
  const rot = el("div", { className: "objective-rotation", attrs: { hidden: "" } });
  const angle = range("objectiveAngleStepSlider", ...settingRange("objectiveAngleStep"), (v) => actions.updateSolverSetting("objectiveAngleStep", parseFloat(v)));
  const speed = range("objectiveRotationSpeedSlider", ...settingRange("objectiveRotationSpeed"), (v) => actions.updateSolverSetting("objectiveRotationSpeed", parseFloat(v)));
  const trace = checkbox("traceCheckbox", (enabled) => actions.setTraceEnabled(enabled));
  const column = (className: string, text: string, control: HTMLInputElement) => el("div", { className }, [el("label", { className: "label-centered", attrs: { for: control.id }, text }), control]);
  rot.append(
    el("div", { className: "rotation-layout" }, [column("rotation-column", "Angle Step", angle), column("rotation-column", "Rotation Speed", speed), column("rotation-checkbox", "Trace", trace)]),
  );
  root.append(rot);
  function render(state: State) {
    const regionDerived = hasRegion(state);
    const hasSolution = (state.originalIteratePath?.count ?? 0) > 0;
    const isRotating = state.rotateObjectiveMode;
    const isAnimating = state.replayActive && !isRotating;

    // the same button stops the replay it started, so it stays enabled while
    // one is playing; its label carries the mode, matching "Stop Rotation"
    animate.textContent = isAnimating ? "Stop Animation" : "Animate";
    animate.disabled = !regionDerived || !hasSolution || isRotating;
    start.disabled = !regionDerived || !hasObjective(state) || isAnimating || isRotating;
    stop.disabled = !isRotating;
    rot.hidden = !isRotating;
    trace.checked = state.traceEnabled;
    angle.value = String(state.solverSettings.objectiveAngleStep);
    speed.value = String(state.solverSettings.objectiveRotationSpeed);
  }
  const stopRender = renderOn(["polytope", "originalIteratePath", "objectiveVector", "rotateObjectiveMode", "replayActive", "traceEnabled", "solverSettings"], render);
  return {
    destroy: () => {
      stopRender();
      root.remove();
    },
  };
}
