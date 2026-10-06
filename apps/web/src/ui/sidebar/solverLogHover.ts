// Hover sync for the solver log: which .iterate-item the pointer is over is
// resolved from the pointer position (elementFromPoint) on a RAF, so a scroll
// or a re-render under a resting pointer updates the highlight too.
export function createSolverLogHover(result: HTMLElement, setIterateHighlight: (index: number | null) => void) {
  let pointerInsideResult = false;
  let pointerX = 0;
  let pointerY = 0;
  let hoverRafId: number | null = null;
  let currentHoveredRow: HTMLElement | null = null;

  const setHoveredRow = (next: HTMLElement | null) => {
    if (currentHoveredRow === next) return;
    currentHoveredRow?.classList.remove("hover");
    currentHoveredRow = next;
    currentHoveredRow?.classList.add("hover");
    const idx = currentHoveredRow?.dataset.index;
    setIterateHighlight(idx !== undefined && idx !== "" ? Number(idx) : null);
  };
  const syncHoverState = () => {
    hoverRafId = null;
    if (!pointerInsideResult) {
      return;
    }
    const element = document.elementFromPoint(pointerX, pointerY);
    const row = element instanceof Element ? element.closest<HTMLElement>(".iterate-item") : null;
    setHoveredRow(row && result.contains(row) ? row : null);
  };
  const scheduleHoverSync = () => {
    if (!pointerInsideResult || hoverRafId !== null) return;
    hoverRafId = requestAnimationFrame(syncHoverState);
  };
  const clearHoverState = () => {
    pointerInsideResult = false;
    setHoveredRow(null);
    if (hoverRafId !== null) {
      cancelAnimationFrame(hoverRafId);
      hoverRafId = null;
    }
  };
  result.addEventListener("pointerenter", (e) => {
    pointerInsideResult = true;
    pointerX = e.clientX;
    pointerY = e.clientY;
    scheduleHoverSync();
  });
  result.addEventListener("pointermove", (e) => {
    if (!pointerInsideResult) return;
    pointerX = e.clientX;
    pointerY = e.clientY;
    scheduleHoverSync();
  });
  result.addEventListener("scroll", scheduleHoverSync, {
    capture: true,
    passive: true,
  });
  result.addEventListener("pointerleave", clearHoverState);
  return {
    scheduleHoverSync,
    clearHoverState,
    // the tracked row's DOM is gone (the result was re-rendered); drop the
    // reference without touching classes or the highlight
    forgetHoveredRow: () => {
      currentHoveredRow = null;
    },
  };
}
