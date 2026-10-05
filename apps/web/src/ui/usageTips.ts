import type { DrawingPhase } from "@/features/core/store";
import { el } from "@/ui/dom";

// [label, description]; the description is HTML (inline <kbd>/<strong>) and
// is assigned via innerHTML.
type UsageTip = [label: string, desc: string];

const USAGE_TIP_SECTIONS: [title: string, tips: UsageTip[]][] = [
  [
    "Drawing the region",
    [
      ["Add a vertex", "click empty space"],
      ["Insert a vertex", "double-click an edge"],
      ["Move a vertex", "drag it"],
      ["Move a constraint", "drag its edge line"],
      ["Delete a vertex", "right-click it"],
      ["Finish the region", "press <kbd>Enter</kbd>"],
    ],
  ],
  [
    "Objective",
    [
      ["Place it", "click inside the region"],
      ["Aim it", "drag the arrow"],
      ["Spin it", "click <strong>Rotate Objective</strong>"],
      ["Hide / show it", "press <kbd>H</kbd>"],
    ],
  ],
  [
    "Solving",
    [
      ["Run a solver", "pick IPM, PDHG, Simplex, Ellipsoid, or Central Path"],
      ["Replay iterations", "click <strong>Animate</strong> (again to stop)"],
      ["Animation length", "press <kbd>+</kbd> / <kbd>-</kbd>"],
      ["Keep a trace", "toggle the <strong>Trace</strong> box"],
      ["Tune a solver", "adjust its sliders"],
      ["Move the start", "drag the gray ring; right-click it to reset"],
    ],
  ],
  [
    "Inspecting",
    [
      ["Highlight a constraint", "hover its row in the top panel"],
      ["Highlight an iterate", "hover its row in the bottom panel"],
      ["See more log rows", "scroll the sidebar"],
    ],
  ],
  [
    "View",
    [
      ["Pan", "drag the canvas"],
      ["Zoom", "scroll"],
      ["Fit to contents", "click the zoom button"],
      ["Recenter", "click the home button"],
      ["Share a link", "click the share button"],
      ["Snap to grid", "press <kbd>S</kbd>"],
      ["Undo / Redo", "<kbd>⌘Z</kbd> / <kbd>⇧⌘Z</kbd>"],
      ["Reset", "click the reset button"],
    ],
  ],
  [
    "3D view",
    [
      ["Toggle 3D", "click the <strong>3D</strong> button"],
      ["Pan", "left-drag"],
      ["Orbit", "right-drag"],
      ["Zoom", "scroll"],
      ["Z-scale", "<kbd>Shift</kbd>+scroll or the slider"],
    ],
  ],
  ["Examples", [["Load a preset", "open the gallery up top, pick a problem"]]],
];

/** Clean, sectioned layout used by the help popover. */
export function usageTipsList(): HTMLDivElement {
  const list = el("div", { className: "usage-tips-list" });
  for (const [title, tips] of USAGE_TIP_SECTIONS) {
    const group = el("div", { className: "usage-tips-section" });
    group.append(el("div", { className: "usage-tips-section__title", text: title }));
    for (const [label, desc] of tips) {
      const row = el("div", { className: "usage-tip" });
      row.append(el("span", { className: "usage-tip__label", text: label }));
      const description = el("span", { className: "usage-tip__desc" });
      description.innerHTML = desc;
      row.append(description);
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

/** Single contextual line shown in the sidebar terminal before any result. */
export function usageHint(phase: DrawingPhase): HTMLDivElement {
  return el("div", { id: "usageHint", text: DRAWING_HINTS[phase] });
}
