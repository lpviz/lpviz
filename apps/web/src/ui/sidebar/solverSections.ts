import type { EllipsoidQueryPoint, SolverMode, SolverSettings } from "@/features/core/store";
import { el } from "@/ui/dom";
import { ENTERING_RULES, LEAVING_RULES, type EnteringRule, type LeavingRule } from "@lpviz/solver-engine/simplex";
import { checkbox, checkboxRow, fixed, maxitSlider, numberSlider, select, setInputValue, type SectionContext, type SettingControl } from "./solverSettingControls";

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

export type SettingsSync = (settings: SolverSettings) => void;

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

function ellipsoidSection(ctx: SectionContext): SettingControl[] {
  const query = select("ellipsoidQueryPoint", QUERY_POINT_OPTIONS, ctx.set("ellipsoidQueryPoint"));
  query.value = ctx.st.ellipsoidQueryPoint;
  const queryRow: SettingControl = {
    nodes: [el("div", { className: "settings-inline-row" }, [el("label", { attrs: { for: "ellipsoidQueryPoint" }, text: "Query point:" }), query])],
    sync: (next) => setInputValue(query, next.ellipsoidQueryPoint),
  };
  return [
    numberSlider(ctx, { key: "ellipsoidInitialScale", min: "1.05", max: "4", step: "0.05", label: "Initial ellipsoid size:", format: fixed(2) }),
    maxitSlider(ctx, "maxitSliderEllipsoid", "maxitEllipsoid"),
    queryRow,
    // the cut shape options belong to the ellipsoid update itself; the
    // other query points localize with a polyhedron and never form one
    checkboxRow(ctx, { ellipsoidDeepCuts: "Deep cuts", ellipsoidRayShoot: "Ray shoot" }, (next, key) => next.ellipsoidQueryPoint === "ellipsoid" || key === "ellipsoidRayShoot"),
  ];
}

function simplexSection(ctx: SectionContext): SettingControl[] {
  const dual = checkbox("simplexDualMode", ctx.set("simplexDualMode"));
  dual.checked = ctx.st.simplexDualMode;
  const entering = select("simplexEnteringRule", ENTERING_RULE_OPTIONS, ctx.set("simplexEnteringRule"));
  entering.value = ctx.st.simplexEnteringRule;
  const leaving = select("simplexLeavingRule", LEAVING_RULE_OPTIONS, ctx.set("simplexLeavingRule"));
  leaving.value = ctx.st.simplexLeavingRule;
  return [
    {
      nodes: [
        el("div", { className: "settings-checkbox-row" }, [el("label", { attrs: { for: "simplexDualMode" }, text: "Dual simplex mode " }, [dual])]),
        // label + dropdown on one line, selects aligned via a 2-column grid
        el("div", { className: "settings-select-grid" }, [
          el("label", { attrs: { for: "simplexEnteringRule" }, text: "Entering:" }),
          entering,
          el("label", { attrs: { for: "simplexLeavingRule" }, text: "Leaving:" }),
          leaving,
        ]),
      ],
      sync: (next) => {
        dual.checked = next.simplexDualMode;
        setInputValue(entering, next.simplexEnteringRule);
        setInputValue(leaving, next.simplexLeavingRule);
      },
    },
  ];
}

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
