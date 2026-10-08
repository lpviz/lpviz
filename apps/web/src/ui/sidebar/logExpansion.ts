// Scrolling the sidebar trades its controls for log height. The log panel
// flex-grows into whatever the panels above leave over, so by default nothing
// overflows and a wheel over the sidebar would do nothing; instead each wheel
// step grows the log by the amount it scrolls the sidebar, the log's bottom
// edge stays pinned to the viewport while its top eats upward into the
// controls, and at zero expansion the inline height is dropped so the layout
// is purely CSS-driven again.
//
// Everything here chains rather than claims: a scroller that can still move in
// the direction of travel keeps the gesture, and the expansion only picks it
// up once nothing else wants it. A terminal keeps the wheel only while its
// inner scroller has content left in that direction; deferring to it
// unconditionally would kill the gesture at an exhausted inner scroller. The
// one asymmetry is that shrinking is always available, because an expansion
// the user cannot undo is a trap.

const LINE_HEIGHT_PX = 16;
const PAGE_FRACTION = 0.8;
// only skip deltas too small to change a fractional pixel: a slow trackpad drag
// is a stream of sub-pixel deltas that would each round away to nothing
const MIN_STEP_PX = 0.01;
const OVERFLOW_SLACK_PX = 1;
// treat a scroller within a pixel of its end as finished, so a fractional
// scrollTop cannot strand the gesture
const SCROLL_END_SLACK_PX = 1;
const TERMINALS = "#terminal-container, #terminal-container2";

// Whether the wheel lands inside a terminal that can still scroll in this
// direction, in which case the terminal keeps the gesture.
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

// Firefox reports constraints, and some setups report pages; normalize to pixels so
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

export function createSidebarLogExpansion({ sidebar, content, logPanel }: { sidebar: HTMLElement; content: HTMLElement; logPanel: HTMLElement }) {
  let expansion = 0;

  // Everything stacked above the log panel, which is also how far the log can
  // grow (at the limit the controls are scrolled off). Measured in content
  // space (scrollTop added back) so it does not move as the sidebar scrolls.
  const roomAbove = () => logPanel.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop;

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

    // Growing waits until the sidebar has nothing left to scroll on its own: a
    // genuinely overflowing sidebar scrolls normally first.
    const atBottom = content.scrollHeight - content.clientHeight - content.scrollTop <= OVERFLOW_SLACK_PX;
    if (delta > 0 && !atBottom) return;
    // Shrinking is always available while there is expansion to give back:
    // gating it on atBottom would strand the log whenever the sidebar grows
    // after expanding (switching to a solver with more settings is enough).
    if (delta < 0 && expansion <= 0) return;

    const next = Math.min(roomAbove(), Math.max(0, expansion + delta));
    const applied = next - expansion;
    if (applied === 0) return;

    // Read scrollTop before the resize: shrinking can make the browser clamp
    // it, and a relative step from the clamped value would move twice as far.
    const scrollTop = content.scrollTop;
    expansion = next;
    applyExpansion();
    // Reading the range back flushes the resize and avoids assuming it moved in
    // step with the panel (flex redistribution and margins can extend it by
    // more than n). Growing only ever happens from the bottom, so pin it there;
    // shrinking keeps its relative step since it can start away from the bottom.
    const maxScroll = content.scrollHeight - content.clientHeight;
    content.scrollTop = applied > 0 ? maxScroll : Math.min(maxScroll, scrollTop + applied);
    event.preventDefault();
  };

  sidebar.addEventListener("wheel", onWheel, { passive: false });

  // The room above changes with the window and the active solver's settings;
  // re-clamp rather than leave the log taller than there is room for.
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
