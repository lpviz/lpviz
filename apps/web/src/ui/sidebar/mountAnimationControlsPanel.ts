import type { AppContext } from "@/app/appContext";
import type { State } from "@/features/core/store";
import { hasObjective, hasRegion } from "@/features/problem/selectors";
import { button, checkbox, el, range } from "@/ui/dom";
import { renderOn } from "@/ui/renderOn";

export function mountAnimationControlsPanel(parent: HTMLElement, ctx: AppContext) {
  const root = el("div", { className: "controlPanel controlPanel--compact" });
  parent.append(root);
  const animate = button("Animate", () => ctx.actions.toggleReplay());
  const start = button("Rotate Objective", () => ctx.actions.startRotation());
  const stop = button("Stop Rotation", () => ctx.actions.stopMotion());
  root.append(el("div", { className: "button-group" }, [animate]), el("div", { className: "button-group" }, [start, stop]));
  const rot = el("div", { className: "objective-rotation is-hidden" });
  const angle = range("objectiveAngleStepSlider", "0.01", "0.5", "0.01", (v) => ctx.actions.updateSolverSetting("objectiveAngleStep", parseFloat(v)));
  const speed = range("objectiveRotationSpeedSlider", "0.2", "3", "0.1", (v) => ctx.actions.updateSolverSetting("objectiveRotationSpeed", parseFloat(v)));
  const trace = checkbox("traceCheckbox", (enabled) => ctx.actions.setTraceEnabled(enabled));
  const column = (className: string, text: string, control: HTMLInputElement) => el("div", { className }, [el("label", { className: "label-centered", attrs: { for: control.id }, text }), control]);
  rot.append(
    el("div", { className: "rotation-layout" }, [column("rotation-column", "Angle Step", angle), column("rotation-column", "Rotation Speed", speed), column("rotation-checkbox", "Trace", trace)]),
  );
  root.append(rot);
  function render(s: State) {
    const regionDerived = hasRegion(s);
    const hasSolution = (s.originalIteratePath?.count ?? 0) > 0;
    const isRotating = s.rotateObjectiveMode;
    const isAnimating = s.replayActive && !isRotating;

    // the same button stops the replay it started, so it stays enabled while
    // one is playing; its label carries the mode, matching "Stop Rotation"
    animate.textContent = isAnimating ? "Stop Animation" : "Animate";
    animate.disabled = !regionDerived || !hasSolution || isRotating;
    start.disabled = !regionDerived || !hasObjective(s) || isAnimating || isRotating;
    stop.disabled = !isRotating;
    rot.className = isRotating ? "objective-rotation is-block" : "objective-rotation is-hidden";
    trace.checked = s.traceEnabled;
    angle.value = String(s.solverSettings.objectiveAngleStep);
    speed.value = String(s.solverSettings.objectiveRotationSpeed);
  }
  const stopRender = renderOn(["polytope", "originalIteratePath", "objectiveVector", "rotateObjectiveMode", "replayActive", "traceEnabled", "solverSettings"], render);
  return {
    destroy: () => {
      stopRender();
      root.remove();
    },
  };
}
