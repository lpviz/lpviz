import { DEFAULT_SOLVER_SETTINGS, getState, nearestPolytopeVertex, type SolverMode, type SolverSettings, type State } from "@/features/core/store";
import type { ShareSettings } from "@/features/share/sharedState";
import { hasUnboundedObjectiveDirection, isEmptyRegion, isSolverSelectable } from "@/features/problem/selectors";
import type { ResultRenderPayload, SolverWorkerPayload } from "@/features/solver/types";
import type { Vec } from "@lpviz/math/types";
import { hasConstraints } from "@lpviz/polytope/polytope";
import { isEnteringRule, isLeavingRule } from "@lpviz/solver-engine/simplex";

export type SolverSettingUpdater = <K extends keyof SolverSettings>(key: K, value: SolverSettings[K]) => void;

export type SolverControl = {
  mode: SolverMode;
  isSelectable: (state: State) => boolean;
  getRunBlock: (state: State) => ResultRenderPayload | null;
  collectShareSettings: () => ShareSettings;
  applySharedSettings: (settings: ShareSettings) => void;
  buildRequest: (state: State) => SolverWorkerPayload | null;
};

// Every share key is also a solver-settings key.
type SharedKey = keyof ShareSettings & keyof SolverSettings;

// The share payload is untrusted (see sharedState.ts). A value reaches the
// store only when it has the default's shape: a finite number, a boolean, or
// one of the engine's rule names. Anything else is dropped so a hand-edited
// link can neither blank a <select> nor throw inside the settings panel's
// store subscriber.
function isValidSharedSetting<K extends SharedKey>(key: K, value: unknown): value is SolverSettings[K] {
  if (key === "simplexEnteringRule") return isEnteringRule(value);
  if (key === "simplexLeavingRule") return isLeavingRule(value);
  const fallback: unknown = DEFAULT_SOLVER_SETTINGS[key];
  return typeof fallback === "number" ? Number.isFinite(value) : typeof value === typeof fallback;
}

// the objective vector + constraint constraints guard common to every buildRequest
function objectiveBase(state: State) {
  if (!state.objectiveVector || !hasConstraints(state.polytope)) return null;
  return {
    constraints: state.polytope.constraints,
    objective: Float64Array.from(state.objectiveVector),
  };
}

// The points the ellipsoid family builds its initial localization around. A
// bounded region's vertices are its polytope's. An unbounded region's polytope
// carries none, but every vertex it has is an interior point of the drawn chain
// (the end edges continue as rays), so the chain bounds them all. Without it
// the engine falls back to a fixed box around the origin, which has no relation
// to the drawing.
function regionBoundingVertices(state: State): Vec[] {
  const vertices = state.polytope?.vertices ?? [];
  return vertices.length > 0 ? vertices : state.vertices;
}

// The dragged start point as a solver payload, or absent when never set (the
// solvers then keep their exact legacy initialization).
function startPointPayload(state: State): { startPoint?: number[] } {
  const point = state.solverStartPoint;
  return point ? { startPoint: point } : {};
}

const messageBlocks = (header: string, message: string): ResultRenderPayload => ({
  type: "blocks",
  blocks: [
    { className: "iterate-header", text: header },
    { className: "iterate-item-nohover", text: message },
  ],
});

const emptyRegionBlock =
  (message: string): SolverControl["getRunBlock"] =>
  (s) =>
    isEmptyRegion(s) ? messageBlocks("No valid region", message) : null;

// A control declares which settings it shares; collect/apply derive from that.
type SolverControlSpec = Omit<SolverControl, "collectShareSettings" | "applySharedSettings"> & { shareKeys: readonly SharedKey[] };

export function createSolverControls({ updateSolverSetting }: { updateSolverSetting: SolverSettingUpdater }): SolverControl[] {
  const specs: SolverControlSpec[] = [
    {
      mode: "central",
      isSelectable: (s) => isSolverSelectable(s, "central"),
      getRunBlock: (s) => {
        if (!hasConstraints(s.polytope)) return null;
        if (s.polytope.kind === "empty") return messageBlocks("No valid region", "Central Path requires a feasible region.");
        if (hasUnboundedObjectiveDirection(s))
          return messageBlocks(
            "Solver unavailable",
            "Central Path is disabled when the objective points in an unbounded direction. Select IPM, PDHG, or Simplex to see how they handle this unbounded problem.",
          );
        return null;
      },
      shareKeys: ["centralPathIter"],
      buildRequest: (s) => {
        const base = objectiveBase(s);
        if (!base || !hasConstraints(s.polytope)) return null;
        return {
          solver: "central",
          vertices: s.polytope.vertices,
          ...base,
          niter: Math.max(1, s.solverSettings.centralPathIter || 1),
        };
      },
    },
    {
      mode: "ipm",
      isSelectable: (s) => isSolverSelectable(s, "ipm"),
      getRunBlock: emptyRegionBlock("IPM requires a feasible region."),
      shareKeys: ["alphaMax", "correctorThreshold", "maxitIPM"],
      buildRequest: (s) => {
        const base = objectiveBase(s);
        if (!base) return null;
        const ss = s.solverSettings;
        return {
          solver: "ipm",
          ...base,
          ...startPointPayload(s),
          alphaMax: ss.alphaMax,
          correctorThreshold: ss.correctorThreshold,
          maxit: Math.max(1, ss.maxitIPM || 1),
        };
      },
    },
    {
      mode: "simplex",
      isSelectable: (s) => isSolverSelectable(s, "simplex"),
      getRunBlock: emptyRegionBlock("Simplex requires a valid feasible region."),
      shareKeys: ["simplexDualMode", "simplexEnteringRule", "simplexLeavingRule"],
      buildRequest: (s) => {
        const base = objectiveBase(s);
        if (!base) return null;
        // Simplex consumes the start as a vertex (the marker snaps to one);
        // dual mode has no safe start-point interpretation and ignores it.
        const snapped = !s.solverSettings.simplexDualMode && s.solverStartPoint ? nearestPolytopeVertex(s, s.solverStartPoint) : null;
        return {
          solver: "simplex",
          ...base,
          ...(snapped ? { startVertex: snapped } : {}),
          dual: s.solverSettings.simplexDualMode,
          enteringRule: s.solverSettings.simplexEnteringRule,
          leavingRule: s.solverSettings.simplexLeavingRule,
        };
      },
    },
    {
      mode: "ellipsoid",
      isSelectable: (s) => isSolverSelectable(s, "ellipsoid"),
      getRunBlock: emptyRegionBlock("The ellipsoid method requires a feasible region."),
      shareKeys: ["maxitEllipsoid", "ellipsoidDeepCuts", "ellipsoidRayShoot", "ellipsoidQueryPoint", "ellipsoidInitialScale"],
      buildRequest: (s) => {
        const base = objectiveBase(s);
        if (!base || !hasConstraints(s.polytope)) return null;
        const ss = s.solverSettings;
        return {
          solver: "ellipsoid",
          // the drawn region bounds the initial ellipsoid (or box)
          vertices: regionBoundingVertices(s),
          ...base,
          maxit: Math.max(1, ss.maxitEllipsoid || 1),
          deepCuts: ss.ellipsoidDeepCuts,
          rayShoot: ss.ellipsoidRayShoot,
          queryPoint: ss.ellipsoidQueryPoint,
          initialScale: ss.ellipsoidInitialScale,
        };
      },
    },
    {
      mode: "pdhg",
      isSelectable: (s) => isSolverSelectable(s, "pdhg"),
      getRunBlock: () => null,
      shareKeys: ["pdhgEta", "pdhgTau", "maxitPDHG", "pdhgIneqMode", "pdhgHalpernMode", "pdhgColorByBasis"],
      buildRequest: (s) => {
        const base = objectiveBase(s);
        if (!base) return null;
        const ss = s.solverSettings;
        return {
          solver: "pdhg",
          ...base,
          ...startPointPayload(s),
          ineq: ss.pdhgIneqMode,
          halpern: ss.pdhgHalpernMode,
          maxit: Math.max(1, ss.maxitPDHG || 1),
          eta: ss.pdhgEta,
          tau: ss.pdhgTau,
          colorByBasis: ss.pdhgColorByBasis,
        };
      },
    },
  ];

  return specs.map(({ shareKeys, ...control }) => ({
    ...control,
    collectShareSettings: () => {
      const s = getState().solverSettings;
      const out: ShareSettings = {};
      for (const k of shareKeys) (out[k] as SolverSettings[SharedKey]) = s[k];
      return out;
    },
    applySharedSettings: (settings) => {
      for (const k of shareKeys) {
        const v: unknown = settings[k];
        if (isValidSharedSetting(k, v)) updateSolverSetting(k, v);
      }
    },
  }));
}
