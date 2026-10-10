import type { DrawingPhase } from "@/features/polytope-editor/editorState";
import { el } from "@/ui/dom";
import { hasCoarsePointer } from "@/ui/pointer";

// A tip's label and description for a mouse and keyboard; the description is HTML (inline
// <kbd>/<strong>) and is assigned via innerHTML. `touch` is the finger's version: a description,
// a label and description, or null for a tip a finger cannot follow, which is left out.
type UsageTip = { label: string; desc: string; touch?: string | { label: string; desc: string } | null };

const USAGE_TIP_SECTIONS: [title: string, tips: UsageTip[]][] = [
  [
    "Drawing the region",
    [
      { label: "Add a vertex", desc: "click empty space", touch: "tap empty space" },
      { label: "Insert a vertex", desc: "double-click an edge", touch: "double-tap an edge" },
      { label: "Move a vertex", desc: "drag it" },
      { label: "Move a constraint", desc: "drag its edge line" },
      { label: "Delete a vertex", desc: "right-click it", touch: null },
      { label: "Finish the region", desc: "press <kbd>Enter</kbd>", touch: { label: "Close the region", desc: "tap the first vertex" } },
    ],
  ],
  [
    "Objective",
    [
      { label: "Place it", desc: "click inside the region", touch: "tap inside the region" },
      { label: "Aim it", desc: "drag the arrow" },
      { label: "Spin it", desc: "click <strong>Rotate Objective</strong>", touch: "tap <strong>Rotate Objective</strong>" },
      { label: "Hide / show it", desc: "press <kbd>H</kbd>", touch: null },
    ],
  ],
  [
    "Solving",
    [
      { label: "Run a solver", desc: "pick IPM, PDHG, Simplex, Ellipsoid, or Central Path" },
      { label: "Replay iterations", desc: "click <strong>Animate</strong> (again to stop)", touch: "tap <strong>Animate</strong> (again to stop)" },
      { label: "Animation length", desc: "press <kbd>+</kbd> / <kbd>-</kbd>", touch: null },
      { label: "Keep a trace", desc: "toggle the <strong>Trace</strong> box" },
      { label: "Tune a solver", desc: "adjust its sliders" },
      { label: "Move the start", desc: "drag the gray ring; right-click it to reset", touch: "drag the gray ring" },
    ],
  ],
  [
    "Inspecting",
    [
      { label: "Highlight a constraint", desc: "hover its row in the top panel", touch: "tap its row in the top panel" },
      { label: "Highlight an iterate", desc: "hover its row in the bottom panel", touch: "tap its row in the bottom panel" },
      { label: "See more log rows", desc: "scroll the sidebar" },
    ],
  ],
  [
    "View",
    [
      { label: "Pan", desc: "drag the canvas" },
      { label: "Zoom", desc: "scroll", touch: "pinch" },
      { label: "Fit to contents", desc: "click the zoom button", touch: "tap the zoom button" },
      { label: "Recenter", desc: "click the home button", touch: "tap the home button" },
      { label: "Share a link", desc: "click the share button", touch: "tap the share button" },
      { label: "Snap to grid", desc: "press <kbd>S</kbd>", touch: null },
      { label: "Undo / Redo", desc: "<kbd>⌘Z</kbd> / <kbd>⇧⌘Z</kbd>", touch: null },
      { label: "Reset", desc: "click the reset button", touch: "tap the reset button" },
    ],
  ],
  [
    "3D view",
    [
      { label: "Toggle 3D", desc: "click the <strong>3D</strong> button", touch: "tap the <strong>3D</strong> button" },
      { label: "Pan", desc: "left-drag", touch: "one-finger drag" },
      { label: "Orbit", desc: "right-drag", touch: "two-finger drag" },
      { label: "Zoom", desc: "scroll", touch: "pinch" },
      { label: "Z-scale", desc: "<kbd>Shift</kbd>+scroll or the slider", touch: "the slider" },
    ],
  ],
  ["Examples", [{ label: "Load a preset", desc: "open the gallery up top, pick a problem" }]],
];

// The tip as the primary input reads it, or null when a finger cannot follow it.
function tipFor(tip: UsageTip, touch: boolean): { label: string; desc: string } | null {
  if (!touch || tip.touch === undefined) return tip;
  if (tip.touch === null) return null;
  return typeof tip.touch === "string" ? { label: tip.label, desc: tip.touch } : tip.touch;
}

/** Clean, sectioned layout used by the help popover, worded for the primary input. */
export function usageTipsList(): HTMLDivElement {
  const touch = hasCoarsePointer();
  const list = el("div", { className: "usage-tips-list" });
  for (const [title, tips] of USAGE_TIP_SECTIONS) {
    const group = el("div", { className: "usage-tips-section" });
    group.append(el("div", { className: "usage-tips-section__title", text: title }));
    for (const tip of tips) {
      const shown = tipFor(tip, touch);
      if (!shown) continue;
      const row = el("div", { className: "usage-tip" });
      row.append(el("span", { className: "usage-tip__label", text: shown.label }));
      row.append(el("span", { className: "usage-tip__desc", html: shown.desc }));
      group.append(row);
    }
    list.append(group);
  }
  return list;
}

// the hint per drawing phase, for a pointer that clicks and a finger that taps
const DRAWING_HINTS: Record<DrawingPhase, [click: string, tap: string]> = {
  empty: ["Click the grid to add vertices.", "Tap the grid to add vertices."],
  sketching_polytope: ["Keep clicking to add vertices — click the first one or press Enter to close.", "Keep tapping to add vertices — tap the first one to close."],
  awaiting_objective: ["Click inside the region to set the objective direction.", "Tap inside the region to set the objective direction."],
  objective_preview: ["Click to lock in the objective direction.", "Tap to lock in the objective direction."],
  ready_for_solvers: ["Pick a solver above to solve.", "Pick a solver above to solve."],
};

/** Single contextual line shown in the sidebar terminal before any result. */
export function usageHint(phase: DrawingPhase): HTMLDivElement {
  return el("div", { id: "usageHint", text: DRAWING_HINTS[phase][hasCoarsePointer() ? 1 : 0] });
}

/** The advice under the hint on a phone or a touch-only device (the stylesheet shows it there). */
export function desktopNote(): HTMLParagraphElement {
  return el("p", { className: "desktop-note", text: "lpviz is best on a desktop browser." });
}
