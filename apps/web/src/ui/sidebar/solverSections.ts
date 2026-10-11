import type { SolverMode, SolverSettings } from "@/features/solver/solverSettings";
import { checkboxRow, fixed, group, labeledSelect, maxitSlider, numberSlider, type SectionContext, type SettingControl } from "./solverSettingControls";

// The labels of each select's vocabulary (the settings table has the values); a Record turns a
// value without a label into a compile error.
const ENTERING_RULE_LABELS: Record<SolverSettings["simplexEnteringRule"], string> = { coeff: "Dantzig", first: "Bland (low)", last: "Bland (high)" };
const LEAVING_RULE_LABELS: Record<SolverSettings["simplexLeavingRule"], string> = { first: "Lowest index", last: "Highest index" };
const QUERY_POINT_LABELS: Record<SolverSettings["ellipsoidQueryPoint"], string> = { ellipsoid: "Ellipsoid", chebyshev: "Chebyshev", analytic: "Analytic", volumetric: "Volumetric" };

export type SettingsSync = SettingControl["sync"];

const ipmSection = (ctx: SectionContext): SettingControl[] => [
  numberSlider(ctx, { key: "alphaMax", min: "0.001", max: "1", step: "0.001", label: "αmax (maximum step size ratio):" }),
  numberSlider(ctx, { key: "correctorThreshold", min: "0.001", max: "0.999", step: "0.001", label: "Corrector threshold:" }),
  maxitSlider(ctx, "maxitSliderIPM", "maxitIPM"),
];

const pdhgSection = (ctx: SectionContext): SettingControl[] => [
  numberSlider(ctx, { key: "pdhgEta", min: "0.001", max: "0.750", step: "0.001", label: "η (primal step size factor):" }),
  numberSlider(ctx, { key: "pdhgTau", min: "0.001", max: "0.750", step: "0.001", label: "τ (dual step size factor):" }),
  maxitSlider(ctx, "maxitSliderPDHG", "maxitPDHG"),
  checkboxRow(ctx, { pdhgIneqMode: "Inequality mode", pdhgHalpernMode: "Halpern", pdhgColorByBasis: "Color by basis" }),
];

const ellipsoidSection = (ctx: SectionContext): SettingControl[] => [
  numberSlider(ctx, { key: "ellipsoidInitialScale", min: "1.05", max: "4", step: "0.05", label: "Initial ellipsoid size:", format: fixed(2) }),
  maxitSlider(ctx, "maxitSliderEllipsoid", "maxitEllipsoid"),
  group("settings-inline-row", [labeledSelect(ctx, "ellipsoidQueryPoint", "Query point:", QUERY_POINT_LABELS)]),
  // the cut shape options belong to the ellipsoid update itself; the
  // other query points localize with a polyhedron and never form one
  checkboxRow(ctx, { ellipsoidDeepCuts: "Deep cuts", ellipsoidRayShoot: "Ray shoot" }, (next, key) => next.ellipsoidQueryPoint === "ellipsoid" || key === "ellipsoidRayShoot"),
];

const simplexSection = (ctx: SectionContext): SettingControl[] => [
  checkboxRow(ctx, { simplexDualMode: "Dual simplex mode" }),
  // label + dropdown on one line, selects aligned via a 2-column grid
  group("settings-select-grid", [labeledSelect(ctx, "simplexEnteringRule", "Entering:", ENTERING_RULE_LABELS), labeledSelect(ctx, "simplexLeavingRule", "Leaving:", LEAVING_RULE_LABELS)]),
];

const centralSection = (ctx: SectionContext): SettingControl[] => [
  numberSlider(ctx, { key: "centralPathIter", min: "2", max: "100", step: "1", label: "N (number of steps):", format: String, parse: (v) => parseInt(v, 10), br: false }),
];

const SECTIONS: Record<SolverMode, (ctx: SectionContext) => SettingControl[]> = {
  ipm: ipmSection,
  pdhg: pdhgSection,
  ellipsoid: ellipsoidSection,
  simplex: simplexSection,
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
