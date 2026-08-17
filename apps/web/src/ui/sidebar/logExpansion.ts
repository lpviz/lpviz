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
// Everything here chains rather than claims: a scroller that can still move in
// the direction of travel keeps the gesture, and this only picks it up once
// nothing else wants it. The one asymmetry is that shrinking is always
// available, because an expansion the user cannot undo is a trap.
//
// Wheels over a terminal are left alone while that terminal still has content
// to scroll — but only while. The terminals are the biggest targets in the
// sidebar and they scroll an inner element, so deferring to them
// unconditionally means the gesture dies wherever that inner scroller is
// exhausted: a short run that fits needs no scrolling at all, and a long one
// still stops dead at its last row. Chaining on to the expansion once they are
// done is what every other nested scroller does.

const LINE_HEIGHT_PX = 16;
const PAGE_FRACTION = 0.8;
// only skip deltas too small to change a fractional pixel; a slow trackpad drag
// arrives as a stream of sub-pixel deltas and rounding each one away
// individually would make a gentle gesture do nothing at all
const MIN_STEP_PX = 0.01;
const OVERFLOW_SLACK_PX = 1;
// treat a scroller within a pixel of its end as finished, so a fractional
// scrollTop cannot strand the gesture
const SCROLL_END_SLACK_PX = 1;
const TERMINALS = "#terminal-container, #terminal-container2";

/**
 * Whether the wheel lands on something inside a terminal that can still scroll
 * in this direction — in which case the terminal keeps the gesture.
 */
function terminalConsumesWheel(target: Element | null, delta: number): boolean {
  const terminal = target?.closest(TERMINALS);
  if (!terminal) return false;
  for (let node = target; node; node = node.parentElement) {
    const room = node.scrollHeight - node.clientHeight;
    if (room > SCROLL_END_SLACK_PX) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") {
        const remaining = delta > 0 ? room - node.scrollTop : node.scrollTop;
        if (remaining > SCROLL_END_SLACK_PX) return true;
      }
    }
    if (node === terminal) break;
  }
  return false;
}

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

    const delta = wheelDeltaPixels(event, content.clientHeight);
    if (Math.abs(delta) < MIN_STEP_PX) return;
    if (terminalConsumesWheel(event.target as Element | null, delta)) return;

    // Growing waits until the sidebar has nothing left to scroll on its own, so
    // a sidebar that genuinely overflows — a short window, a tall settings
    // panel — scrolls normally first and only then starts trading controls for
    // log.
    const atBottom =
      content.scrollHeight - content.clientHeight - content.scrollTop <=
      OVERFLOW_SLACK_PX;
    if (delta > 0 && !atBottom) return;
    // Shrinking, though, is always available while there is expansion to give
    // back. Gating it on the same condition strands the log: anything that
    // makes the sidebar taller after it was expanded — switching to a solver
    // with more settings is enough — leaves an expansion that can never be
    // undone, and the gesture stops responding entirely.
    if (delta < 0 && expansion <= 0) return;

    const next = Math.min(roomAbove(), Math.max(0, expansion + delta));
    const applied = next - expansion;
    if (applied === 0) return;

    // Read the scroll position before the resize: shrinking the panel can make
    // the browser clamp scrollTop on its own, and a relative adjustment would
    // then move twice as far as the wheel asked for.
    const scrollTop = content.scrollTop;
    expansion = next;
    applyExpansion();
    // Reading the range back both flushes the resize and avoids assuming it
    // moved in step with the panel: flex redistribution and margins mean
    // growing the log by n can extend the scrollable range by more than n, and
    // advancing scrollTop by n alone would leave the view short of the bottom.
    // Growing only ever happens from the bottom, so pin it there and let any
    // discrepancy correct itself; shrinking keeps its relative step, since it
    // can legitimately start away from the bottom.
    const maxScroll = content.scrollHeight - content.clientHeight;
    content.scrollTop =
      applied > 0 ? maxScroll : Math.min(maxScroll, scrollTop + applied);
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
