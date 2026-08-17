import type { DrawingPhase } from "@/features/core/store";
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
      { label: "Replay iterations", desc: "click <strong>Animate</strong>" },
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
    tips: [
      { label: "Load a preset", desc: "open the gallery up top, pick a problem" },
    ],
  },
];

/** Clean, sectioned layout used by the help popover. */
export function usageTipsList(): HTMLDivElement {
  const list = el("div", { className: "usage-tips-list" });
  for (const section of USAGE_TIP_SECTIONS) {
    const group = el("div", { className: "usage-tips-section" });
    group.append(
      el("div", { className: "usage-tips-section__title", text: section.title }),
    );
    for (const tip of section.tips) {
      const row = el("div", { className: "usage-tip" });
      row.append(
        el("span", { className: "usage-tip__label", text: tip.label }),
      );
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
  sketching_polytope:
    "Keep clicking to add vertices — click the first one or press Enter to close.",
  awaiting_objective: "Click inside the region to set the objective direction.",
  objective_preview: "Click to lock in the objective direction.",
  ready_for_solvers: "Pick a solver above to solve.",
};

/** Single contextual line shown in the sidebar terminal before any result. */
export function usageHint(phase: DrawingPhase): HTMLDivElement {
  return el("div", { id: "usageHint", text: DRAWING_HINTS[phase] });
}
