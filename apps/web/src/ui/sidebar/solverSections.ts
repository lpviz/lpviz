import type { EllipsoidQueryPoint, SolverMode, State } from "@/features/core/store";
import { el } from "@/ui/dom";
import { ENTERING_RULES, LEAVING_RULES, type EnteringRule, type LeavingRule } from "@lpviz/solver-engine/simplex";
import { checkbox, checkboxRow, fixed, numberSlider, renderMaxit, select, setInputValue, type SectionContext } from "./solverSettingControls";

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

export type SettingsSync = (state: State) => void;

function ipmSection(sec: HTMLElement, ctx: SectionContext): SettingsSync {
  const alpha = numberSlider(ctx, { key: "alphaMax", min: "0.001", max: "1", step: "0.001", label: "αmax (maximum step size ratio):" });
  const corrector = numberSlider(ctx, { key: "correctorThreshold", min: "0.001", max: "0.999", step: "0.001", label: "Corrector threshold:" });
  const maxit = renderMaxit(ctx, "maxitSliderIPM", "maxitIPM");
  sec.append(...alpha.nodes, ...corrector.nodes, maxit.element);
  return (s) => {
    alpha.sync(s.solverSettings);
    corrector.sync(s.solverSettings);
    maxit.sync(s.solverSettings);
  };
}

function pdhgSection(sec: HTMLElement, ctx: SectionContext): SettingsSync {
  const eta = numberSlider(ctx, { key: "pdhgEta", min: "0.001", max: "0.750", step: "0.001", label: "η (primal step size factor):" });
  const tau = numberSlider(ctx, { key: "pdhgTau", min: "0.001", max: "0.750", step: "0.001", label: "τ (dual step size factor):" });
  const maxit = renderMaxit(ctx, "maxitSliderPDHG", "maxitPDHG");
  const { row, boxes } = checkboxRow(ctx, { pdhgIneqMode: "Inequality mode", pdhgHalpernMode: "Halpern", pdhgColorByBasis: "Color by basis" });
  sec.append(...eta.nodes, ...tau.nodes, maxit.element, row);
  return (s) => {
    const next = s.solverSettings;
    eta.sync(next);
    tau.sync(next);
    maxit.sync(next);
    for (const [key, cb] of boxes) cb.checked = next[key];
  };
}

function ellipsoidSection(sec: HTMLElement, ctx: SectionContext): SettingsSync {
  const scale = numberSlider(ctx, { key: "ellipsoidInitialScale", min: "1.05", max: "4", step: "0.05", label: "Initial ellipsoid size:", format: fixed(2) });
  const maxit = renderMaxit(ctx, "maxitSliderEllipsoid", "maxitEllipsoid");
  const query = select("ellipsoidQueryPoint", QUERY_POINT_OPTIONS, ctx.set("ellipsoidQueryPoint"));
  query.value = ctx.st.ellipsoidQueryPoint;
  const { row, boxes } = checkboxRow(ctx, { ellipsoidDeepCuts: "Deep cuts", ellipsoidRayShoot: "Ray shoot" });
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

function simplexSection(sec: HTMLElement, ctx: SectionContext): SettingsSync {
  const dual = checkbox("simplexDualMode", ctx.set("simplexDualMode"));
  dual.checked = ctx.st.simplexDualMode;
  const entering = select("simplexEnteringRule", ENTERING_RULE_OPTIONS, ctx.set("simplexEnteringRule"));
  entering.value = ctx.st.simplexEnteringRule;
  const leaving = select("simplexLeavingRule", LEAVING_RULE_OPTIONS, ctx.set("simplexLeavingRule"));
  leaving.value = ctx.st.simplexLeavingRule;
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

function centralSection(sec: HTMLElement, ctx: SectionContext): SettingsSync {
  const n = numberSlider(ctx, { key: "centralPathIter", min: "2", max: "100", step: "1", label: "N (number of steps):", format: String, parse: (v) => parseInt(v, 10), br: false });
  sec.append(...n.nodes);
  return (s) => n.sync(s.solverSettings);
}

// Fills `sec` with the solver's controls and returns the sync that refreshes
// them from state.
export function buildSolverSection(mode: SolverMode, sec: HTMLElement, ctx: SectionContext): SettingsSync {
  if (mode === "ipm") return ipmSection(sec, ctx);
  if (mode === "pdhg") return pdhgSection(sec, ctx);
  if (mode === "ellipsoid") return ellipsoidSection(sec, ctx);
  if (mode === "simplex") return simplexSection(sec, ctx);
  return centralSection(sec, ctx);
}
