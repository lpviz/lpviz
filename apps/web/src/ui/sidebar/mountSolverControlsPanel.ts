import type { AppContext } from "@/app/appContext";
import {
  computeDrawingPhase,
  getState,
  on,
  type SolverMode,
  type SolverSettings,
  type State,
} from "@/features/core/store";
import { el } from "@/ui/dom";
import { isObjectiveDirectionUnbounded } from "@lpviz/polytope/objectiveDirection";
import { hasPolytopeLines } from "@lpviz/polytope/polytopeTypes";

const MAXIT_LOG_MIN = 0,
  MAXIT_LOG_MAX = 5,
  MAXIT_LOG_STEP = 0.01;
const maxitToSliderValue = (value: number) =>
  Math.min(
    MAXIT_LOG_MAX,
    Math.max(MAXIT_LOG_MIN, Math.log10(Math.max(1, value))),
  );
const sliderValueToMaxit = (value: string) =>
  Math.max(1, Math.round(10 ** parseFloat(value)));
const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const fmt = (value: number) => NUMBER_FORMAT.format(value);

type MaxitSettingKey = Extract<keyof SolverSettings, "maxitIPM" | "maxitPDHG">;
type SettingsSync = (state: State) => void;
type SettingField = HTMLInputElement | HTMLSelectElement;

type SolverButtonUiState = {
  active: boolean;
  disabled: boolean;
};

function range(
  id: string,
  min: string,
  max: string,
  step: string,
  onInput: (v: string) => void,
) {
  const i = el("input", {
    attrs: { type: "range", id, min, max, step, autocomplete: "off" },
  });
  i.addEventListener("input", () => onInput((i as HTMLInputElement).value));
  return i as HTMLInputElement;
}
function checkbox(id: string, onChange: (v: boolean) => void) {
  const i = el("input", {
    attrs: { type: "checkbox", id },
  }) as HTMLInputElement;
  i.addEventListener("change", () => onChange(i.checked));
  return i;
}
function dropdown<T extends string>(
  id: string,
  options: readonly { value: T; text: string }[],
  initial: T,
  onChange: (v: T) => void,
) {
  const s = el("select", {
    attrs: { id, autocomplete: "off" },
  }) as HTMLSelectElement;
  for (const opt of options) {
    s.append(el("option", { attrs: { value: opt.value }, text: opt.text }));
  }
  s.value = initial;
  s.addEventListener("change", () => onChange(s.value as T));
  return s;
}
function labeled(
  text: string,
  id: string,
  control: HTMLElement,
  value?: HTMLElement,
  includeBreak = false,
) {
  const fragment = document.createDocumentFragment();
  const label = el("label", { attrs: { for: id } });
  label.append(text);
  if (value) label.append(" ", value);
  fragment.append(label, control);
  if (includeBreak) fragment.append(el("br"));
  return fragment;
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
  mkButton("central", "Central Path", "iteratePathButton");

  const settings = el("div");
  root.append(settings);

  let renderedMode: SolverMode | null = null;
  let syncSettings: SettingsSync = () => {};

  function setInputValue(input: SettingField, value: string) {
    if (document.activeElement !== input) input.value = value;
  }

  function renderMaxit(
    id: string,
    value: number,
    key: MaxitSettingKey,
    mode: SolverMode,
  ): { element: HTMLElement; sync: (settings: SolverSettings) => void } {
    const span = el("span", { text: fmt(value) });
    const input = range(
      id,
      String(MAXIT_LOG_MIN),
      String(MAXIT_LOG_MAX),
      String(MAXIT_LOG_STEP),
      (v) => {
        const maxit = sliderValueToMaxit(v);
        span.textContent = fmt(maxit);
        ctx.actions.updateSolverSetting(key, maxit);
        ctx.actions.recomputeIfModeActive(mode);
      },
    );
    input.classList.add("log-slider");
    input.value = String(maxitToSliderValue(value));
    const wrap = el("div", { className: "log-slider-control" });
    const label = el("label", {
      attrs: { for: id },
      text: "Maximum iterations:",
    });
    label.append(" ", span);
    wrap.append(
      label,
      input,
      el(
        "div",
        { className: "log-slider-scale", attrs: { "aria-hidden": "true" } },
        [
          el("span", { text: "1" }),
          el("span", { text: "10" }),
          el("span", { text: "100" }),
          el("span", { text: "1k" }),
          el("span", { text: "10k" }),
          el("span", { text: "100k" }),
        ],
      ),
    );
    return {
      element: wrap,
      sync: (st) => {
        span.textContent = fmt(st[key]);
        setInputValue(input, String(maxitToSliderValue(st[key])));
      },
    };
  }

  function buildSettings(mode: SolverMode, st: SolverSettings): SettingsSync {
    settings.replaceChildren();
    const sec = el("div", { className: "settings-section is-block" });
    settings.append(sec);

    if (mode === "ipm") {
      const v1 = el("span", { text: st.alphaMax.toFixed(3) });
      const a = range("alphaMaxSlider", "0.001", "1", "0.001", (v) => {
        const next = parseFloat(v);
        v1.textContent = next.toFixed(3);
        ctx.actions.updateSolverSetting("alphaMax", next);
        ctx.actions.recomputeIfModeActive("ipm");
      });
      a.value = String(st.alphaMax);
      sec.append(
        labeled(
          "αmax (maximum step size ratio):",
          "alphaMaxSlider",
          a,
          v1,
          true,
        ),
      );

      const v2 = el("span", { text: st.correctorThreshold.toFixed(3) });
      const c = range(
        "correctorThresholdSlider",
        "0.001",
        "0.999",
        "0.001",
        (v) => {
          const next = parseFloat(v);
          v2.textContent = next.toFixed(3);
          ctx.actions.updateSolverSetting("correctorThreshold", next);
          ctx.actions.recomputeIfModeActive("ipm");
        },
      );
      c.value = String(st.correctorThreshold);
      const maxit = renderMaxit(
        "maxitSliderIPM",
        st.maxitIPM,
        "maxitIPM",
        "ipm",
      );
      sec.append(
        labeled(
          "Corrector threshold:",
          "correctorThresholdSlider",
          c,
          v2,
          true,
        ),
        maxit.element,
      );
      return (s) => {
        const next = s.solverSettings;
        v1.textContent = next.alphaMax.toFixed(3);
        setInputValue(a, String(next.alphaMax));
        v2.textContent = next.correctorThreshold.toFixed(3);
        setInputValue(c, String(next.correctorThreshold));
        maxit.sync(next);
      };
    }

    if (mode === "pdhg") {
      const etaValue = el("span", { text: st.pdhgEta.toFixed(3) });
      const eta = range("pdhgEtaSlider", "0.001", "0.750", "0.001", (v) => {
        const next = parseFloat(v);
        etaValue.textContent = next.toFixed(3);
        ctx.actions.updateSolverSetting("pdhgEta", next);
        ctx.actions.recomputeIfModeActive("pdhg");
      });
      eta.value = String(st.pdhgEta);

      const tauValue = el("span", { text: st.pdhgTau.toFixed(3) });
      const tau = range("pdhgTauSlider", "0.001", "0.750", "0.001", (v) => {
        const next = parseFloat(v);
        tauValue.textContent = next.toFixed(3);
        ctx.actions.updateSolverSetting("pdhgTau", next);
        ctx.actions.recomputeIfModeActive("pdhg");
      });
      tau.value = String(st.pdhgTau);
      const maxit = renderMaxit(
        "maxitSliderPDHG",
        st.maxitPDHG,
        "maxitPDHG",
        "pdhg",
      );

      sec.append(
        labeled(
          "η (primal step size factor):",
          "pdhgEtaSlider",
          eta,
          etaValue,
          true,
        ),
        labeled(
          "τ (dual step size factor):",
          "pdhgTauSlider",
          tau,
          tauValue,
          true,
        ),
        maxit.element,
      );
      const row = el("div", { className: "settings-checkbox-row" });
      const checkboxes = (
        [
          ["pdhgIneqMode", "Inequality mode"],
          ["pdhgHalpernMode", "Halpern"],
          ["pdhgColorByBasis", "Color by basis"],
        ] as const
      ).map(([key, label]) => {
        const cb = checkbox(key, (v) => {
          ctx.actions.updateSolverSetting(key, v);
          ctx.actions.recomputeIfModeActive("pdhg");
        });
        cb.checked = st[key];
        row.append(
          el("label", { attrs: { for: key }, text: label + " " }, [cb]),
        );
        return [key, cb] as const;
      });
      sec.append(row);
      return (s) => {
        const next = s.solverSettings;
        etaValue.textContent = next.pdhgEta.toFixed(3);
        setInputValue(eta, String(next.pdhgEta));
        tauValue.textContent = next.pdhgTau.toFixed(3);
        setInputValue(tau, String(next.pdhgTau));
        maxit.sync(next);
        for (const [key, cb] of checkboxes) cb.checked = next[key];
      };
    }

    if (mode === "simplex") {
      const dual = checkbox("simplexDualMode", (v) => {
        ctx.actions.updateSolverSetting("simplexDualMode", v);
        ctx.actions.recomputeIfModeActive("simplex");
      });
      dual.checked = st.simplexDualMode;
      const enteringOptions = [
        { value: "coeff", text: "Highest objective coeff" },
        { value: "first", text: "Lowest index" },
        { value: "last", text: "Highest index" },
      ] as const;
      const entering = dropdown(
        "simplexEnteringRule",
        enteringOptions,
        st.simplexEnteringRule,
        (v) => {
          ctx.actions.updateSolverSetting("simplexEnteringRule", v);
          ctx.actions.recomputeIfModeActive("simplex");
        },
      );
      const leavingOptions = [
        { value: "first", text: "Lowest index" },
        { value: "last", text: "Highest index" },
      ] as const;
      const leaving = dropdown(
        "simplexLeavingRule",
        leavingOptions,
        st.simplexLeavingRule,
        (v) => {
          ctx.actions.updateSolverSetting("simplexLeavingRule", v);
          ctx.actions.recomputeIfModeActive("simplex");
        },
      );
      sec.append(
        el("div", { className: "settings-checkbox-row" }, [
          el(
            "label",
            { attrs: { for: "simplexDualMode" }, text: "Dual simplex mode " },
            [dual],
          ),
        ]),
        labeled("Entering rule:", "simplexEnteringRule", entering, undefined, true),
        labeled("Leaving rule (ratio test):", "simplexLeavingRule", leaving, undefined, true),
      );
      return (s) => {
        dual.checked = s.solverSettings.simplexDualMode;
        setInputValue(entering, String(s.solverSettings.simplexEnteringRule));
        setInputValue(leaving, String(s.solverSettings.simplexLeavingRule));
      };
    }

    const nValue = el("span", { text: String(st.centralPathIter) });
    const n = range("centralPathIterSlider", "2", "100", "1", (v) => {
      const next = parseInt(v, 10);
      nValue.textContent = String(next);
      ctx.actions.updateSolverSetting("centralPathIter", next);
      ctx.actions.recomputeIfModeActive("central");
    });
    n.value = String(st.centralPathIter);
    sec.append(
      labeled("N (number of steps):", "centralPathIterSlider", n, nValue),
    );
    return (s) => {
      nValue.textContent = String(s.solverSettings.centralPathIter);
      setInputValue(n, String(s.solverSettings.centralPathIter));
    };
  }

  function getSolverButtonUiState(
    state: State,
    mode: SolverMode,
  ): SolverButtonUiState {
    const hasComputedLines = hasPolytopeLines(state.polytope);
    const readyForSolvers =
      computeDrawingPhase(state) === "ready_for_solvers" &&
      hasComputedLines &&
      state.objectiveVector !== null;

    return {
      active: state.solverMode === mode,
      disabled: !readyForSolvers || !isSolverSelectable(state, mode),
    };
  }

  function isSolverSelectable(state: State, mode: SolverMode): boolean {
    if (!hasPolytopeLines(state.polytope)) return false;
    if (
      state.polytope.kind !== "bounded" &&
      state.polytope.kind !== "unbounded"
    ) {
      return false;
    }
    if (
      mode !== "central" ||
      !state.objectiveVector ||
      state.polytope.kind !== "unbounded"
    ) {
      return true;
    }
    return !isObjectiveDirectionUnbounded(state.polytope.lines, [
      state.objectiveVector.x,
      state.objectiveVector.y,
    ]);
  }

  function render(s: State) {
    for (const mode of ["ipm", "pdhg", "simplex", "central"] as SolverMode[]) {
      const ui = getSolverButtonUiState(s, mode);
      const b = buttons.get(mode)!;
      b.className = ui.active ? "button-active" : "";
      b.disabled = ui.disabled;
    }
    if (renderedMode !== s.solverMode) {
      renderedMode = s.solverMode;
      syncSettings = buildSettings(s.solverMode, s.solverSettings);
    }
    syncSettings(s);
  }

  render(getState());
  const controller = new AbortController();
  on(
    [
      "solverMode",
      "solverSettings",
      "polytope",
      "vertices",
      "completionMode",
      "objectiveVector",
      "currentObjective",
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
