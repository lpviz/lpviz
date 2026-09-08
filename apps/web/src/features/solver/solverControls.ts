import {
  getState,
  nearestPolytopeVertex,
  type SolverMode,
  type SolverSettings,
  type State,
} from "@/features/core/store";
import type { ShareSettings } from "@/features/share/sharedState";
import type { ResultRenderPayload } from "@/features/solver/solverService";
import type { SolverWorkerPayload } from "@/features/solver/solverWorker";
import { hasPolytopeLines } from "@lpviz/polytope/polytopeTypes";

export type SolverSettingUpdater = <K extends keyof SolverSettings>(
  key: K,
  value: SolverSettings[K],
) => void;

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

const hasFeasibleRegion = (state: State): boolean =>
  hasPolytopeLines(state.polytope) &&
  (state.polytope.kind === "bounded" || state.polytope.kind === "unbounded");

const isEmptyRegion = (state: State): boolean =>
  hasPolytopeLines(state.polytope) && state.polytope.kind === "empty";

// the objective vector + constraint lines guard common to every buildRequest
function objectiveBase(state: State) {
  if (!state.objectiveVector || !hasPolytopeLines(state.polytope)) return null;
  return {
    lines: state.polytope.lines,
    objective: Float64Array.of(
      state.objectiveVector.x,
      state.objectiveVector.y,
    ),
  };
}

// The dragged start point as a solver payload, or absent when never set (the
// solvers then keep their exact legacy initialization).
function startPointPayload(state: State): { startPoint?: number[] } {
  const point = state.solverStartPoint;
  return point ? { startPoint: [point.x, point.y] } : {};
}

const messageBlocks = (
  header: string,
  message: string,
): ResultRenderPayload => ({
  type: "blocks",
  blocks: [
    { className: "iterate-header", text: header },
    { className: "iterate-item-nohover", text: message },
  ],
});

export function createSolverControls({
  updateSolverSetting,
  hasUnboundedObjectiveDirection,
}: {
  updateSolverSetting: SolverSettingUpdater;
  hasUnboundedObjectiveDirection: (state: State) => boolean;
}): SolverControl[] {
  const collectShared = (keys: readonly SharedKey[]): ShareSettings => {
    const s = getState().solverSettings;
    const out: ShareSettings = {};
    for (const k of keys) (out[k] as SolverSettings[SharedKey]) = s[k];
    return out;
  };
  const applyShared = (
    settings: ShareSettings,
    keys: readonly SharedKey[],
  ): void => {
    for (const k of keys) {
      const v = settings[k];
      if (v !== undefined) updateSolverSetting(k, v as SolverSettings[SharedKey]);
    }
  };

  return [
    {
      mode: "central",
      isSelectable: (s) =>
        hasFeasibleRegion(s) && !hasUnboundedObjectiveDirection(s),
      getRunBlock: (s) => {
        if (!hasPolytopeLines(s.polytope)) return null;
        if (s.polytope.kind === "empty")
          return messageBlocks(
            "No valid region",
            "Central Path requires a feasible region.",
          );
        if (hasUnboundedObjectiveDirection(s))
          return messageBlocks(
            "Solver unavailable",
            "Central Path is disabled when the objective points in an unbounded direction. Select IPM, PDHG, or Simplex to see how they handle this unbounded problem.",
          );
        return null;
      },
      collectShareSettings: () => collectShared(["centralPathIter"]),
      applySharedSettings: (settings) =>
        applyShared(settings, ["centralPathIter"]),
      buildRequest: (s) => {
        const base = objectiveBase(s);
        if (!base || !hasPolytopeLines(s.polytope)) return null;
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
      isSelectable: hasFeasibleRegion,
      getRunBlock: (s) =>
        isEmptyRegion(s)
          ? messageBlocks("No valid region", "IPM requires a feasible region.")
          : null,
      collectShareSettings: () =>
        collectShared(["alphaMax", "correctorThreshold", "maxitIPM"]),
      applySharedSettings: (settings) =>
        applyShared(settings, ["alphaMax", "correctorThreshold", "maxitIPM"]),
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
      isSelectable: hasFeasibleRegion,
      getRunBlock: (s) =>
        isEmptyRegion(s)
          ? messageBlocks(
              "No valid region",
              "Simplex requires a valid feasible region.",
            )
          : null,
      collectShareSettings: () =>
        collectShared(["simplexDualMode", "simplexEnteringRule", "simplexLeavingRule"]),
      applySharedSettings: (settings) =>
        applyShared(settings, ["simplexDualMode", "simplexEnteringRule", "simplexLeavingRule"]),
      buildRequest: (s) => {
        const base = objectiveBase(s);
        if (!base) return null;
        // Simplex consumes the start as a vertex (the marker snaps to one);
        // dual mode has no safe start-point interpretation and ignores it.
        const snapped =
          !s.solverSettings.simplexDualMode && s.solverStartPoint
            ? nearestPolytopeVertex(s, s.solverStartPoint)
            : null;
        return {
          solver: "simplex",
          ...base,
          ...(snapped ? { startVertex: [snapped.x, snapped.y] } : {}),
          dual: s.solverSettings.simplexDualMode,
          enteringRule: s.solverSettings.simplexEnteringRule,
          leavingRule: s.solverSettings.simplexLeavingRule,
        };
      },
    },
    {
      mode: "pdhg",
      isSelectable: hasFeasibleRegion,
      getRunBlock: () => null,
      collectShareSettings: () =>
        collectShared([
          "pdhgEta",
          "pdhgTau",
          "maxitPDHG",
          "pdhgIneqMode",
          "pdhgHalpernMode",
          "pdhgColorByBasis",
        ]),
      applySharedSettings: (settings) =>
        applyShared(settings, [
          "pdhgEta",
          "pdhgTau",
          "maxitPDHG",
          "pdhgIneqMode",
          "pdhgHalpernMode",
          "pdhgColorByBasis",
        ]),
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
}
