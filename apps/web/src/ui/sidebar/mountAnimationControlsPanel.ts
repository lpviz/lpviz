import type { AppContext } from "@/app/appContext";
import { getState, on, type State } from "@/features/core/store";
import { hasObjective, hasRegion } from "@/features/problem/selectors";
import { el, range } from "@/ui/dom";

export function mountAnimationControlsPanel(parent: HTMLElement, ctx: AppContext) {
  const root = el("div", { className: "controlPanel controlPanel--compact" });
  parent.append(root);
  const animate = el("button", { text: "Animate" });
  animate.addEventListener("click", () => ctx.actions.toggleReplay());
  const start = el("button", {
    id: "startRotateObjectiveButton",
    text: "Rotate Objective",
  });
  start.addEventListener("click", () => ctx.actions.startRotation());
  const stop = el("button", { text: "Stop Rotation" });
  stop.addEventListener("click", () => ctx.actions.stopMotion());
  root.append(el("div", { className: "button-group" }, [animate]), el("div", { className: "button-group" }, [start, stop]));
  const rot = el("div", { className: "objective-rotation is-hidden" });
  const angle = range("objectiveAngleStepSlider", "0.01", "0.5", "0.01", (v) => ctx.actions.updateSolverSetting("objectiveAngleStep", parseFloat(v)));
  const speed = range("objectiveRotationSpeedSlider", "0.2", "3", "0.1", (v) => ctx.actions.updateSolverSetting("objectiveRotationSpeed", parseFloat(v)));
  const trace = el("input", {
    attrs: { type: "checkbox", id: "traceCheckbox" },
  });
  trace.addEventListener("change", () => ctx.actions.setTraceEnabled(trace.checked));
  rot.append(
    el("div", { className: "rotation-layout" }, [
      el("div", { className: "rotation-column" }, [
        el("label", {
          className: "label-centered",
          attrs: { for: "objectiveAngleStepSlider" },
          text: "Angle Step",
        }),
        angle,
      ]),
      el("div", { className: "rotation-column" }, [
        el("label", {
          className: "label-centered",
          attrs: { for: "objectiveRotationSpeedSlider" },
          text: "Rotation Speed",
        }),
        speed,
      ]),
      el("div", { className: "rotation-checkbox" }, [
        el("label", {
          className: "label-centered",
          attrs: { for: "traceCheckbox" },
          text: "Trace",
        }),
        trace,
      ]),
    ]),
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
  render(getState());
  const controller = new AbortController();
  on(["polytope", "originalIteratePath", "objectiveVector", "rotateObjectiveMode", "replayActive", "traceEnabled", "solverSettings"], () => render(getState()), controller.signal);
  return {
    destroy: () => {
      controller.abort();
      root.remove();
    },
  };
}
