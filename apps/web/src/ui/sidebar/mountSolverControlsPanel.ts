import type { AppContext } from "@/app/appContext";
import { computeDrawingPhase, getState, on, type EllipsoidQueryPoint, type SolverMode, type SolverSettings, type State } from "@/features/core/store";
import { el, range } from "@/ui/dom";
import { isObjectiveDirectionUnbounded } from "@lpviz/polytope/objectiveDirection";
import { hasPolytopeLines } from "@lpviz/polytope/polytopeTypes";
import { ENTERING_RULES, LEAVING_RULES, type EnteringRule, type LeavingRule } from "@lpviz/solver-engine/simplex";

const MAXIT_LOG_MIN = 0,
  MAXIT_LOG_MAX = 5,
  MAXIT_LOG_STEP = 0.01;
const maxitToSliderValue = (value: number) => Math.min(MAXIT_LOG_MAX, Math.max(MAXIT_LOG_MIN, Math.log10(Math.max(1, value))));
const sliderValueToMaxit = (value: string) => Math.max(1, Math.round(10 ** parseFloat(value)));
const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const fmt = (value: number) => NUMBER_FORMAT.format(value);
const fixed = (digits: number) => (value: number) => value.toFixed(digits);

// The rule vocabulary comes from the engine; a Record turns a rule without a
// label into a compile error.
const ENTERING_RULE_LABELS: Record<EnteringRule, string> = { coeff: "Dantzig", first: "Bland (low)", last: "Bland (high)" };
const LEAVING_RULE_LABELS: Record<LeavingRule, string> = { first: "Lowest index", last: "Highest index" };
const ENTERING_RULE_OPTIONS = ENTERING_RULES.map((value) => [value, ENTERING_RULE_LABELS[value]] as const);
const LEAVING_RULE_OPTIONS = LEAVING_RULES.map((value) => [value, LEAVING_RULE_LABELS[value]] as const);
const QUERY_POINT_OPTIONS = [
  ["ellipsoid", "Ellipsoid"],
  ["chebyshev", "Chebyshev"],
  ["analytic", "Analytic"],
  ["volumetric", "Volumetric"],
] as const satisfies readonly (readonly [EllipsoidQueryPoint, string])[];

type SettingKeys<T> = { [K in keyof SolverSettings]: SolverSettings[K] extends T ? K : never }[keyof SolverSettings];
type MaxitSettingKey = Extract<keyof SolverSettings, "maxitIPM" | "maxitPDHG" | "maxitEllipsoid">;
type SettingsSync = (state: State) => void;
type SettingField = HTMLInputElement | HTMLSelectElement;
type SliderSpec = { key: SettingKeys<number>; min: string; max: string; step: string; label: string; format?: (v: number) => string; parse?: (v: string) => number; br?: boolean };

function checkbox(id: string, onChange: (v: boolean) => void) {
  const i = el("input", { attrs: { type: "checkbox", id } });
  i.addEventListener("change", () => onChange(i.checked));
  return i;
}
function select<T extends string>(id: string, options: readonly (readonly [T, string])[], onChange: (v: T) => void) {
  const s = el(
    "select",
    { attrs: { id, autocomplete: "off" } },
    options.map(([value, label]) => el("option", { attrs: { value }, text: label })),
  );
  s.addEventListener("change", () => onChange(s.value as T));
  return s;
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

  function setInputValue(input: SettingField, value: string) {
    if (document.activeElement !== input) input.value = value;
  }

  // A slider (id `<key>Slider`) with a live readout: <label>text " " <span></label>,
  // the input, and a <br> unless `br` is false.
  function numberSlider(st: SolverSettings, mode: SolverMode, { key, min, max, step, label, format = fixed(3), parse = parseFloat, br = true }: SliderSpec) {
    const id = key + "Slider";
    const span = el("span", { text: format(st[key]) });
    const update = set(mode)(key);
    const input = range(id, min, max, step, (v) => {
      const next = parse(v);
      span.textContent = format(next);
      update(next);
    });
    input.value = String(st[key]);
    const text = el("label", { attrs: { for: id } });
    text.append(label, " ", span);
    const nodes: Node[] = [text, input];
    if (br) nodes.push(el("br"));
    return {
      nodes,
      sync: (next: SolverSettings) => {
        span.textContent = format(next[key]);
        setInputValue(input, String(next[key]));
      },
    };
  }

  // one <label>text " "<input type=checkbox></label> per entry, in order
  function checkboxRow(st: SolverSettings, mode: SolverMode, labels: Partial<Record<SettingKeys<boolean>, string>>) {
    const row = el("div", { className: "settings-checkbox-row" });
    const boxes = (Object.entries(labels) as [SettingKeys<boolean>, string][]).map(([key, label]) => {
      const cb = checkbox(key, set(mode)(key));
      cb.checked = st[key];
      const wrap = el("label", { attrs: { for: key }, text: label + " " }, [cb]);
      row.append(wrap);
      return [key, cb, wrap] as const;
    });
    return { row, boxes };
  }

  function renderMaxit(st: SolverSettings, id: string, key: MaxitSettingKey, mode: SolverMode) {
    const span = el("span", { text: fmt(st[key]) });
    const update = set(mode)(key);
    const input = range(id, String(MAXIT_LOG_MIN), String(MAXIT_LOG_MAX), String(MAXIT_LOG_STEP), (v) => {
      const maxit = sliderValueToMaxit(v);
      span.textContent = fmt(maxit);
      update(maxit);
    });
    input.classList.add("log-slider");
    input.value = String(maxitToSliderValue(st[key]));
    const wrap = el("div", { className: "log-slider-control" });
    const label = el("label", { attrs: { for: id }, text: "Maximum iterations:" });
    label.append(" ", span);
    const scale = ["1", "10", "100", "1k", "10k", "100k"].map((text) => el("span", { text }));
    wrap.append(label, input, el("div", { className: "log-slider-scale", attrs: { "aria-hidden": "true" } }, scale));
    return {
      element: wrap,
      sync: (next: SolverSettings) => {
        span.textContent = fmt(next[key]);
        setInputValue(input, String(maxitToSliderValue(next[key])));
      },
    };
  }

  function buildSettings(mode: SolverMode, st: SolverSettings): SettingsSync {
    settings.replaceChildren();
    const sec = el("div", { className: "settings-section is-block" });
    settings.append(sec);

    if (mode === "ipm") {
      const alpha = numberSlider(st, mode, { key: "alphaMax", min: "0.001", max: "1", step: "0.001", label: "αmax (maximum step size ratio):" });
      const corrector = numberSlider(st, mode, { key: "correctorThreshold", min: "0.001", max: "0.999", step: "0.001", label: "Corrector threshold:" });
      const maxit = renderMaxit(st, "maxitSliderIPM", "maxitIPM", mode);
      sec.append(...alpha.nodes, ...corrector.nodes, maxit.element);
      return (s) => {
        alpha.sync(s.solverSettings);
        corrector.sync(s.solverSettings);
        maxit.sync(s.solverSettings);
      };
    }

    if (mode === "pdhg") {
      const eta = numberSlider(st, mode, { key: "pdhgEta", min: "0.001", max: "0.750", step: "0.001", label: "η (primal step size factor):" });
      const tau = numberSlider(st, mode, { key: "pdhgTau", min: "0.001", max: "0.750", step: "0.001", label: "τ (dual step size factor):" });
      const maxit = renderMaxit(st, "maxitSliderPDHG", "maxitPDHG", mode);
      const { row, boxes } = checkboxRow(st, mode, { pdhgIneqMode: "Inequality mode", pdhgHalpernMode: "Halpern", pdhgColorByBasis: "Color by basis" });
      sec.append(...eta.nodes, ...tau.nodes, maxit.element, row);
      return (s) => {
        const next = s.solverSettings;
        eta.sync(next);
        tau.sync(next);
        maxit.sync(next);
        for (const [key, cb] of boxes) cb.checked = next[key];
      };
    }

    if (mode === "ellipsoid") {
      const scale = numberSlider(st, mode, { key: "ellipsoidInitialScale", min: "1.05", max: "4", step: "0.05", label: "Initial ellipsoid size:", format: fixed(2) });
      const maxit = renderMaxit(st, "maxitSliderEllipsoid", "maxitEllipsoid", mode);
      const query = select("ellipsoidQueryPoint", QUERY_POINT_OPTIONS, set(mode)("ellipsoidQueryPoint"));
      query.value = st.ellipsoidQueryPoint;
      const { row, boxes } = checkboxRow(st, mode, { ellipsoidDeepCuts: "Deep cuts", ellipsoidRayShoot: "Ray shoot" });
      const queryRow = el("div", { className: "settings-inline-row" }, [el("label", { attrs: { for: "ellipsoidQueryPoint" }, text: "Query point:" }), query]);
      sec.append(...scale.nodes, maxit.element, queryRow, row);
      return (s) => {
        const next = s.solverSettings;
        scale.sync(next);
        maxit.sync(next);
        setInputValue(query, next.ellipsoidQueryPoint);
        // the cut shape options belong to the ellipsoid update itself; the
        // other query points localize with a polyhedron and never form one
        const cutsApply = next.ellipsoidQueryPoint === "ellipsoid";
        for (const [key, cb, wrap] of boxes) {
          cb.checked = next[key];
          const applies = cutsApply || key === "ellipsoidRayShoot";
          cb.disabled = !applies;
          wrap.classList.toggle("is-disabled", !applies);
        }
      };
    }

    if (mode === "simplex") {
      const dual = checkbox("simplexDualMode", set(mode)("simplexDualMode"));
      dual.checked = st.simplexDualMode;
      const entering = select("simplexEnteringRule", ENTERING_RULE_OPTIONS, set(mode)("simplexEnteringRule"));
      entering.value = st.simplexEnteringRule;
      const leaving = select("simplexLeavingRule", LEAVING_RULE_OPTIONS, set(mode)("simplexLeavingRule"));
      leaving.value = st.simplexLeavingRule;
      sec.append(
        el("div", { className: "settings-checkbox-row" }, [el("label", { attrs: { for: "simplexDualMode" }, text: "Dual simplex mode " }, [dual])]),
        // label + dropdown on one line, selects aligned via a 2-column grid
        el("div", { className: "settings-select-grid" }, [
          el("label", { attrs: { for: "simplexEnteringRule" }, text: "Entering:" }),
          entering,
          el("label", { attrs: { for: "simplexLeavingRule" }, text: "Leaving:" }),
          leaving,
        ]),
      );
      return (s) => {
        dual.checked = s.solverSettings.simplexDualMode;
        setInputValue(entering, s.solverSettings.simplexEnteringRule);
        setInputValue(leaving, s.solverSettings.simplexLeavingRule);
      };
    }

    const n = numberSlider(st, mode, { key: "centralPathIter", min: "2", max: "100", step: "1", label: "N (number of steps):", format: String, parse: (v) => parseInt(v, 10), br: false });
    sec.append(...n.nodes);
    return (s) => n.sync(s.solverSettings);
  }

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
