import type { SolverMode, SolverSettings } from "@/features/solver/solverSettings";
import { checkboxRow, fixed, group, labeledSelect, maxitSlider, numberSlider, type SectionContext, type SettingControl, shownWhen } from "./solverSettingControls";

// The labels of each select's vocabulary (the settings table has the values); a Record turns a
// value without a label into a compile error.
const ENTERING_RULE_LABELS: Record<SolverSettings["simplexEnteringRule"], string> = { coeff: "Dantzig", first: "Bland (low)", last: "Bland (high)" };
const LEAVING_RULE_LABELS: Record<SolverSettings["simplexLeavingRule"], string> = { first: "Lowest index", last: "Highest index" };
const QUERY_POINT_LABELS: Record<SolverSettings["ellipsoidQueryPoint"], string> = {
  ellipsoid: "Ellipsoid",
  chebyshev: "Chebyshev",
  analytic: "Analytic",
  volumetric: "Volumetric",
  lpOptimum: "Constraint gen.",
};

const ACTIVE_SET_METHOD_LABELS: Record<SolverSettings["activeSetMethod"], string> = { pdas: "PDAS (proximal)", crissCross: "Criss-cross" };
const INDEX_ORDER_LABELS: Record<SolverSettings["activeSetIndexOrder"], string> = { first: "Lowest first", last: "Highest first" };

export type SettingsSync = SettingControl["sync"];

const ipmSection = (ctx: SectionContext): SettingControl[] => [
  numberSlider(ctx, { key: "alphaMax", label: "αmax (maximum step size ratio):" }),
  numberSlider(ctx, { key: "correctorThreshold", label: "Corrector threshold:" }),
  maxitSlider(ctx, "maxitSliderIPM", "maxitIPM"),
];

// H-PDLP always runs its own Halpern scheme on the inequality form; eta and tau are its eta and sigma
const isClassicPdhg = (settings: SolverSettings) => !settings.pdhgHsd;
const isHsd = (settings: SolverSettings) => settings.pdhgHsd;
const pdhgSection = (ctx: SectionContext): SettingControl[] => [
  numberSlider(ctx, { key: "pdhgEta", label: "η (primal step size factor):" }),
  numberSlider(ctx, { key: "pdhgTau", label: "τ (dual step size factor):" }),
  shownWhen(numberSlider(ctx, { key: "pdhgHsdNu", label: "ν (homogeneous step coupling):", format: fixed(3) }), isHsd),
  maxitSlider(ctx, "maxitSliderPDHG", "maxitPDHG"),
  checkboxRow(ctx, { pdhgHsd: "H-PDLP", pdhgHsdAdaptiveWeight: "Adaptive weight", pdhgIneqMode: "Inequality mode", pdhgHalpernMode: "Halpern", pdhgColorByBasis: "Color by basis" }, (next, key) =>
    key === "pdhgHsdAdaptiveWeight" ? isHsd(next) : isClassicPdhg(next) || key === "pdhgHsd" || key === "pdhgColorByBasis",
  ),
];

const ellipsoidSection = (ctx: SectionContext): SettingControl[] => [
  numberSlider(ctx, { key: "ellipsoidInitialScale", label: "Initial ellipsoid size:", format: fixed(2) }),
  maxitSlider(ctx, "maxitSliderEllipsoid", "maxitEllipsoid"),
  group("settings-inline-row", [labeledSelect(ctx, "ellipsoidQueryPoint", "Query point:", QUERY_POINT_LABELS)]),
  // the cut shape options belong to the ellipsoid update itself; the
  // other query points localize with a polyhedron and never form one. Constraint generation's
  // feasible query is already optimal, so it has nothing to ray-shoot either
  checkboxRow(
    ctx,
    { ellipsoidDeepCuts: "Deep cuts", ellipsoidRayShoot: "Ray shoot" },
    (next, key) => next.ellipsoidQueryPoint === "ellipsoid" || (key === "ellipsoidRayShoot" && next.ellipsoidQueryPoint !== "lpOptimum"),
  ),
];

const simplexSection = (ctx: SectionContext): SettingControl[] => [
  checkboxRow(ctx, { simplexDualMode: "Dual simplex mode" }),
  // label + dropdown on one line, selects aligned via a 2-column grid
  group("settings-select-grid", [labeledSelect(ctx, "simplexEnteringRule", "Entering:", ENTERING_RULE_LABELS), labeledSelect(ctx, "simplexLeavingRule", "Leaving:", LEAVING_RULE_LABELS)]),
];

// each method shows only its own knobs; the iteration cap is shared
const isPdas = (settings: SolverSettings) => settings.activeSetMethod === "pdas";
const activeSetSection = (ctx: SectionContext): SettingControl[] => [
  group("settings-inline-row", [labeledSelect(ctx, "activeSetMethod", "Method:", ACTIVE_SET_METHOD_LABELS)]),
  shownWhen(group("settings-inline-row", [labeledSelect(ctx, "activeSetIndexOrder", "Index order:", INDEX_ORDER_LABELS)]), (settings) => !isPdas(settings)),
  shownWhen(
    group("settings-pdas", [
      numberSlider(ctx, { key: "activeSetRho", label: "ρ (primal proximal weight):", format: fixed(2) }),
      numberSlider(ctx, { key: "activeSetDelta", label: "δ (dual proximal weight):", format: fixed(2) }),
    ]),
    isPdas,
  ),
  maxitSlider(ctx, "maxitSliderActiveSet", "maxitActiveSet"),
  shownWhen(checkboxRow(ctx, { activeSetShrinkWeights: "Shrink weights", activeSetIdentify: "Identify vertex" }), isPdas),
];

const centralSection = (ctx: SectionContext): SettingControl[] => [
  numberSlider(ctx, { key: "centralPathIter", label: "N (number of steps):", format: String, parse: (v) => parseInt(v, 10), br: false }),
];

const SECTIONS: Record<SolverMode, (ctx: SectionContext) => SettingControl[]> = {
  ipm: ipmSection,
  pdhg: pdhgSection,
  ellipsoid: ellipsoidSection,
  simplex: simplexSection,
  activeSet: activeSetSection,
  central: centralSection,
};

// Fills `sec` with the solver's controls and returns the sync that refreshes
// them from the settings.
export function buildSolverSection(mode: SolverMode, sec: HTMLElement, ctx: SectionContext): SettingsSync {
  const controls = SECTIONS[mode](ctx);
  sec.append(...controls.flatMap((control) => control.nodes));
  return (settings) => {
    for (const control of controls) control.sync(settings);
  };
}
