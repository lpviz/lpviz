import type { GalleryProblem } from "@/features/problem-gallery/problems";
import type { SolverMode, SolverSettings } from "./store";

export type AppActions = {
  setConstraintHighlight: (index: number | null) => void;
  setIterateHighlight: (index: number | null) => void;
  updateSolverSetting: <K extends keyof SolverSettings>(
    key: K,
    value: SolverSettings[K],
  ) => void;
  recomputeIfModeActive: (mode: SolverMode) => void;
  setTraceEnabled: (enabled: boolean) => void;
  // one control for both directions: starts a replay, or stops the running one
  toggleReplay: () => void;
  startRotation: () => void;
  stopRotation: () => void;
  share: () => void;
  zoomToFit: () => void;
  resetView: () => void;
  toggle3D: () => void;
  setZScale: (value: number) => void;
  setActiveSolverMode: (mode: SolverMode) => void;
  setSidebarWidth: (width: number) => void;
  syncViewportLayout: (sidebarWidth: number) => void;
  loadGalleryProblem: (problem: GalleryProblem) => void;
};
