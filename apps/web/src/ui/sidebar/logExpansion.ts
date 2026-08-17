// Scrolling the sidebar trades its controls for log height.
//
// The log panel flex-grows into whatever the panels above it leave over, so by
// default everything fits exactly and the sidebar never scrolls. That makes a
// scroll gesture over it feel broken: the obvious thing to want when you spin
// the wheel there is more log rows at once, and nothing happens.
//
// So each wheel step grows the log by the same amount it scrolls the sidebar.
// The log's bottom edge stays pinned to the bottom of the viewport while its
// top edge eats upward into the controls, which scroll away above it — the log
// visibly claims the space rather than the view jumping. Scrolling back up
// hands the controls back, and at zero the inline height is dropped so the
// layout goes back to being purely CSS-driven.
//
// Wheels over a terminal are left alone: those scroll their own content, which
// is what a terminal-shaped thing full of text should do.

const LINE_HEIGHT_PX = 16;
const PAGE_FRACTION = 0.8;
// sub-pixel deltas would accumulate rounding noise for no visible movement
const MIN_STEP_PX = 0.5;
const OVERFLOW_SLACK_PX = 1;

// Firefox reports lines, and some setups report pages; normalize to pixels so
// one notch means the same thing everywhere.
function wheelDeltaPixels(event: WheelEvent, viewportHeight: number): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return event.deltaY * LINE_HEIGHT_PX;
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY * viewportHeight * PAGE_FRACTION;
  }
  return event.deltaY;
}

export function createSidebarLogExpansion({
  sidebar,
  content,
  logPanel,
}: {
  sidebar: HTMLElement;
  content: HTMLElement;
  logPanel: HTMLElement;
}) {
  let expansion = 0;

  // Distance from the top of the scrollable content to the top of the log
  // panel: everything stacked above it. That is also exactly how far the log
  // can grow — at the limit it fills the viewport with the controls scrolled
  // off. Measured in content space (hence adding scrollTop back), so it does
  // not move as the sidebar scrolls.
  const roomAbove = () =>
    logPanel.getBoundingClientRect().top -
    content.getBoundingClientRect().top +
    content.scrollTop;

  const applyExpansion = () => {
    if (expansion <= 0) {
      logPanel.style.minHeight = "";
      return;
    }
    const fitted = content.clientHeight - roomAbove();
    logPanel.style.minHeight = `${Math.max(0, fitted) + expansion}px`;
  };

  const onWheel = (event: WheelEvent) => {
    // a pinch gesture arrives as ctrl+wheel; that is the browser's zoom
    if (event.ctrlKey) return;
    const target = event.target as Element | null;
    if (target?.closest("#terminal-container, #terminal-container2")) return;

    // If the sidebar overflows for reasons of its own — a short window, a tall
    // settings panel — it is already scrollable and scrolling should just
    // scroll it. Only take over the gesture when there is nothing else for it
    // to do.
    const foreignOverflow =
      content.scrollHeight - content.clientHeight - expansion;
    if (foreignOverflow > OVERFLOW_SLACK_PX) return;

    const delta = wheelDeltaPixels(event, content.clientHeight);
    if (Math.abs(delta) < MIN_STEP_PX) return;

    const next = Math.min(roomAbove(), Math.max(0, expansion + delta));
    const applied = next - expansion;
    if (applied === 0) return;

    // Read the scroll position before the resize: shrinking the panel can make
    // the browser clamp scrollTop on its own, and a relative adjustment would
    // then move twice as far as the wheel asked for.
    const scrollTop = content.scrollTop;
    expansion = next;
    applyExpansion();
    content.scrollTop = scrollTop + applied;
    event.preventDefault();
  };

  sidebar.addEventListener("wheel", onWheel, { passive: false });

  // The room above changes with the window and with the settings the active
  // solver renders, so re-clamp instead of leaving the log taller than there is
  // room for.
  const observer = new ResizeObserver(() => {
    if (expansion === 0) return;
    const clamped = Math.min(expansion, Math.max(0, roomAbove()));
    if (clamped === expansion) return;
    expansion = clamped;
    applyExpansion();
  });
  observer.observe(content);

  return {
    destroy: () => {
      sidebar.removeEventListener("wheel", onWheel);
      observer.disconnect();
      logPanel.style.minHeight = "";
    },
  };
}
