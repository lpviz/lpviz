import type { AppActions } from "@/app/appActions";
import { onAbort } from "@/features/core/lifetime";
import { on } from "@/features/core/store";
import { SOLVER_LABELS } from "@/features/solver/solverSettings";

// The pieces of the record-mode screen a take can hide, from the URL (`hide=sidebar,label`) or a
// script (`d.hide("formulation")`). Each is a class on <html> the stylesheet acts on; hiding the
// whole sidebar also hands its width to the canvas, so the plot centers in the full window.
export const RECORD_PARTS = ["sidebar", "brand", "formulation", "solvers", "label", "cursor"] as const;
export type RecordPart = (typeof RECORD_PARTS)[number];

const isPart = (name: string): name is RecordPart => (RECORD_PARTS as readonly string[]).includes(name);

/** The parts named in `hide=` (comma separated), plus the sidebar for `focus=plot`. */
export function partsFromParams(params: URLSearchParams): RecordPart[] {
  const names = (params.get("hide") ?? "").split(",").map((s) => s.trim());
  if (params.get("focus") === "plot") names.push("sidebar");
  const unknown = names.filter((n) => n && !isPart(n));
  if (unknown.length) console.warn(`record: unknown hide part(s) ${unknown.join(", ")}; known: ${RECORD_PARTS.join(", ")}`);
  return [...new Set(names.filter(isPart))];
}

export type PartsController = {
  hide: (...parts: RecordPart[]) => void;
  show: (...parts: RecordPart[]) => void;
  isHidden: (part: RecordPart) => boolean;
  /** back to exactly these hidden */
  set: (parts: readonly RecordPart[]) => void;
};

export function createParts(root: HTMLElement, actions: Pick<AppActions, "setSidebarWidth">, signal: AbortSignal): PartsController {
  const html = document.documentElement;
  const hidden = new Set<RecordPart>();

  // The layout owns the sidebar width and re-applies it on every resize; while the sidebar is
  // hidden this listener, registered after it, puts the zero back.
  let shownWidth: string | null = null;
  const applySidebar = () => {
    if (!hidden.has("sidebar")) return;
    root.style.setProperty("--sidebar-width", "0px");
    actions.setSidebarWidth(0);
  };
  window.addEventListener("resize", applySidebar, { signal });

  // With the solver buttons out of the shot, a label on the plot names the solver instead.
  const label = Object.assign(document.createElement("div"), { className: "record-solver-label" });
  root.append(label);
  const syncLabel = () => html.classList.toggle("record-label-auto", (hidden.has("sidebar") || hidden.has("solvers")) && !hidden.has("label"));
  // a new solver's name fades out the old one first, rather than swapping text under the eye
  let swap: number | undefined;
  on(
    ["solverMode", "originalIteratePath"],
    ({ solverMode, originalIteratePath }) => {
      const text = SOLVER_LABELS[solverMode];
      const visible = originalIteratePath.count > 0;
      clearTimeout(swap);
      if (label.textContent === text || !label.classList.contains("record-solver-label--visible")) {
        label.textContent = text;
        label.classList.toggle("record-solver-label--visible", visible);
        return;
      }
      label.classList.remove("record-solver-label--visible");
      swap = window.setTimeout(() => {
        label.textContent = text;
        label.classList.toggle("record-solver-label--visible", visible);
      }, 220);
    },
    signal,
  );
  onAbort(signal, () => clearTimeout(swap));

  const render = () => {
    for (const part of RECORD_PARTS) html.classList.toggle(`record-hide-${part}`, hidden.has(part));
    if (hidden.has("sidebar")) {
      shownWidth ??= root.style.getPropertyValue("--sidebar-width");
      applySidebar();
    } else if (shownWidth !== null) {
      root.style.setProperty("--sidebar-width", shownWidth);
      actions.setSidebarWidth(Number.parseFloat(shownWidth) || 0);
      shownWidth = null;
    }
    syncLabel();
  };

  onAbort(signal, () => {
    hidden.clear();
    render();
    label.remove();
  });

  return {
    hide: (...parts) => {
      for (const p of parts) hidden.add(p);
      render();
    },
    show: (...parts) => {
      for (const p of parts) hidden.delete(p);
      render();
    },
    isHidden: (part) => hidden.has(part),
    set: (parts) => {
      hidden.clear();
      for (const p of parts) hidden.add(p);
      render();
    },
  };
}
