import type { AppContext } from "@/app/appContext";
import { getState, on, type State } from "@/features/core/store";
import { el } from "@/ui/dom";
import { hasPolytopeLines } from "@lpviz/polytope/polytopeTypes";

export function mountAnimationControlsPanel(
  parent: HTMLElement,
  ctx: AppContext,
) {
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
  stop.addEventListener("click", () => ctx.actions.stopRotation());
  root.append(
    el("div", { className: "button-group" }, [animate]),
    el("div", { className: "button-group" }, [start, stop]),
  );
  const rot = el("div", { className: "objective-rotation is-hidden" });
  const angle = el("input", {
    attrs: {
      type: "range",
      id: "objectiveAngleStepSlider",
      min: "0.01",
      max: "0.5",
      step: "0.01",
      autocomplete: "off",
    },
  }) as HTMLInputElement;
  angle.addEventListener("input", () =>
    ctx.actions.updateSolverSetting(
      "objectiveAngleStep",
      parseFloat(angle.value),
    ),
  );
  const speed = el("input", {
    attrs: {
      type: "range",
      id: "objectiveRotationSpeedSlider",
      min: "0.2",
      max: "3",
      step: "0.1",
      autocomplete: "off",
    },
  }) as HTMLInputElement;
  speed.addEventListener("input", () =>
    ctx.actions.updateSolverSetting(
      "objectiveRotationSpeed",
      parseFloat(speed.value),
    ),
  );
  const trace = el("input", {
    attrs: { type: "checkbox", id: "traceCheckbox" },
  }) as HTMLInputElement;
  trace.addEventListener("change", () =>
    ctx.actions.setTraceEnabled(trace.checked),
  );
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
    const hasComputedLines = hasPolytopeLines(s.polytope);
    const hasSolution = (s.originalIteratePath?.count ?? 0) > 0;
    const hasObjective = s.objectiveVector !== null;
    const isRotating = s.rotateObjectiveMode;
    const isAnimating = s.replayActive && !isRotating;

    // the same button stops the replay it started, so it stays enabled while
    // one is playing; its label carries the mode, matching "Stop Rotation"
    animate.textContent = isAnimating ? "Stop Animation" : "Animate";
    animate.disabled = !hasComputedLines || !hasSolution || isRotating;
    start.disabled =
      !hasComputedLines || !hasObjective || isAnimating || isRotating;
    stop.disabled = !isRotating;
    rot.className = isRotating
      ? "objective-rotation is-block"
      : "objective-rotation is-hidden";
    trace.checked = s.traceEnabled;
    angle.value = String(s.solverSettings.objectiveAngleStep);
    speed.value = String(s.solverSettings.objectiveRotationSpeed);
  }
  render(getState());
  const controller = new AbortController();
  on(
    [
      "polytope",
      "originalIteratePath",
      "objectiveVector",
      "rotateObjectiveMode",
      "replayActive",
      "traceEnabled",
      "solverSettings",
    ],
    () => render(getState()),
    controller.signal,
  );
  return {
    destroy: () => {
      controller.abort();
      root.remove();
    },
  };
}
