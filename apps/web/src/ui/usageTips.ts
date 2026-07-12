import type { DrawingPhase, Editor3Phase } from "@/features/core/store";
import { el } from "@/ui/dom";

interface UsageTip {
  label: string;
  /** HTML-safe description; may contain inline <kbd>/<strong>. */
  desc: string;
}

interface UsageTipSection {
  title: string;
  tips: UsageTip[];
}

const USAGE_TIP_SECTIONS: UsageTipSection[] = [
  {
    title: "Drawing the region",
    tips: [
      { label: "Add a vertex", desc: "click empty space" },
      { label: "Insert a vertex", desc: "double-click an edge" },
      { label: "Move a vertex", desc: "drag it" },
      { label: "Move a constraint", desc: "drag its edge line" },
      { label: "Delete a vertex", desc: "right-click it" },
      { label: "Finish the region", desc: "press <kbd>Enter</kbd>" },
    ],
  },
  {
    title: "Objective",
    tips: [
      { label: "Place it", desc: "click inside the region" },
      { label: "Aim it", desc: "drag the arrow" },
      { label: "Spin it", desc: "click <strong>Rotate Objective</strong>" },
      { label: "Hide / show it", desc: "press <kbd>H</kbd>" },
    ],
  },
  {
    title: "Solving",
    tips: [
      {
        label: "Run a solver",
        desc: "pick IPM, PDHG, Simplex, Ellipsoid, or Central Path",
      },
      {
        label: "Replay iterations",
        desc: "click <strong>Animate</strong> (again to stop)",
      },
      {
        label: "Animation length",
        desc: "press <kbd>+</kbd> / <kbd>-</kbd>",
      },
      { label: "Keep a trace", desc: "toggle the <strong>Trace</strong> box" },
      { label: "Tune a solver", desc: "adjust its sliders" },
      {
        label: "Move the start",
        desc: "drag the gray ring; right-click it to reset",
      },
    ],
  },
  {
    title: "Inspecting",
    tips: [
      {
        label: "Highlight a constraint",
        desc: "hover its row in the top panel",
      },
      {
        label: "Highlight an iterate",
        desc: "hover its row in the bottom panel",
      },
      { label: "See more log rows", desc: "scroll the sidebar" },
    ],
  },
  {
    title: "View",
    tips: [
      { label: "Pan", desc: "drag the canvas" },
      { label: "Zoom", desc: "scroll" },
      { label: "Fit to contents", desc: "click the zoom button" },
      { label: "Recenter", desc: "click the home button" },
      { label: "Share a link", desc: "click the share button" },
      { label: "Snap to grid", desc: "press <kbd>S</kbd>" },
      { label: "Undo / Redo", desc: "<kbd>⌘Z</kbd> / <kbd>⇧⌘Z</kbd>" },
      { label: "Reset", desc: "refresh the page" },
    ],
  },
  {
    title: "3D view",
    tips: [
      { label: "Toggle 3D", desc: "click the <strong>3D</strong> button" },
      { label: "Pan", desc: "left-drag" },
      { label: "Orbit", desc: "right-drag" },
      { label: "Zoom", desc: "scroll" },
      { label: "Z-scale", desc: "<kbd>Shift</kbd>+scroll or the slider" },
    ],
  },
  {
    title: "Examples",
    tips: [{ label: "Load a preset", desc: "open the gallery up top, pick a problem" }],
  },
];

const USAGE_TIP_SECTIONS_3D: UsageTipSection[] = [
  {
    title: "Building the solid",
    tips: [
      { label: "Sketch the base", desc: "click the grid to add vertices" },
      { label: "Close the base", desc: "click the first vertex or press <kbd>Enter</kbd>" },
      { label: "Extrude", desc: "drag the orange handle upward" },
      { label: "Move a vertex", desc: "drag it" },
      { label: "Split a facet", desc: "double-click it, drag the new vertex" },
      { label: "Push / pull a face", desc: "drag it along its normal" },
      { label: "Cut a corner", desc: "double-click it" },
      { label: "Bevel an edge", desc: "double-click it" },
      { label: "Delete a vertex", desc: "right-click it" },
      { label: "Delete a facet", desc: "hover it, press <kbd>X</kbd>" },
    ],
  },
  {
    title: "Objective",
    tips: [
      { label: "Aim it", desc: "move the mouse, click to lock in" },
      { label: "Re-aim it", desc: "drag the arrow tip" },
      { label: "Sweep the sphere", desc: "click <strong>Rotate Objective</strong>" },
      { label: "Keep a trace", desc: "toggle the <strong>Trace</strong> box" },
      { label: "Hide / show it", desc: "press <kbd>H</kbd>" },
    ],
  },
  {
    title: "Solving",
    tips: [
      {
        label: "Run a solver",
        desc: "pick IPM, PDHG, Simplex, or Central Path",
      },
      { label: "Replay iterations", desc: "click <strong>Animate</strong>" },
      { label: "Tune a solver", desc: "adjust its sliders" },
      {
        label: "Highlight a facet",
        desc: "hover its row in the top panel",
      },
      {
        label: "Highlight an iterate",
        desc: "hover its row in the bottom panel",
      },
    ],
  },
  {
    title: "View",
    tips: [
      { label: "Pan", desc: "left-drag empty space" },
      { label: "Orbit", desc: "right-drag" },
      { label: "Zoom", desc: "scroll" },
      { label: "Fit to contents", desc: "click the zoom button" },
      { label: "Share a link", desc: "click the share button" },
      { label: "Snap to grid", desc: "press <kbd>S</kbd>" },
      { label: "Undo / Redo", desc: "<kbd>⌘Z</kbd> / <kbd>⇧⌘Z</kbd>" },
      { label: "2-variable mode", desc: "click the <strong>2D</strong> button" },
    ],
  },
];

/** Clean, sectioned layout used by the help popover. */
export function usageTipsList(problemMode: "2d" | "3d" = "2d"): HTMLDivElement {
  const sections = problemMode === "3d" ? USAGE_TIP_SECTIONS_3D : USAGE_TIP_SECTIONS;
  const list = el("div", { className: "usage-tips-list" });
  for (const section of sections) {
    const group = el("div", { className: "usage-tips-section" });
    group.append(el("div", { className: "usage-tips-section__title", text: section.title }));
    for (const tip of section.tips) {
      const row = el("div", { className: "usage-tip" });
      row.append(el("span", { className: "usage-tip__label", text: tip.label }));
      const desc = el("span", { className: "usage-tip__desc" });
      desc.innerHTML = tip.desc;
      row.append(desc);
      group.append(row);
    }
    list.append(group);
  }
  return list;
}

const DRAWING_HINTS: Record<DrawingPhase, string> = {
  empty: "Click the grid to add vertices.",
  sketching_polytope: "Keep clicking to add vertices — click the first one or press Enter to close.",
  awaiting_objective: "Click inside the region to set the objective direction.",
  objective_preview: "Click to lock in the objective direction.",
  ready_for_solvers: "Pick a solver above to solve.",
};

// 3-variable mode hints, keyed by the CAD build phase (the extrude phase maps
// to the same DrawingPhase as sketching, so it gets its own entry).
const DRAWING_HINTS_3D: Record<Editor3Phase, string> = {
  sketch: "Click the grid to sketch the base polygon — click the first vertex (or inside the sketch, or press Enter) to close it.",
  extrude: "Drag the orange handle upward to extrude the solid.",
  objective: "Move the mouse to aim the objective, then click to lock it in.",
  ready: "Pick a solver above — drag vertices and faces to reshape, double-click a face to add a vertex, a corner or edge to cut.",
};

/** Single contextual line shown in the sidebar terminal before any result. */
export function usageHint(phase: DrawingPhase, editor3Phase?: Editor3Phase): HTMLDivElement {
  const text = editor3Phase !== undefined ? (phase === "empty" ? DRAWING_HINTS.empty.replace("vertices", "the base polygon's vertices") : DRAWING_HINTS_3D[editor3Phase]) : DRAWING_HINTS[phase];
  return el("div", { id: "usageHint", text });
}
