import type { AppActions } from "@/app/appActions";

const DEFAULT_SIDEBAR_WIDTH = 450;
const MOBILE_LAYOUT_QUERY = "(max-width: 700px) and (orientation: portrait)";

export type Layout = ReturnType<typeof createLayout>;

// Sidebar geometry: its desktop width, its mobile height, the mobile/desktop switch, and the
// handle drag that resizes it. The stylesheet lays the sidebar, its handle and the gallery out
// from two root variables; the viewport runtime is told the width the sidebar takes from it.
// `attach` installs the window listeners; `destroy` removes them.
export function createLayout(root: HTMLElement, viewport: Pick<AppActions, "setSidebarWidth">) {
  let sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
  let mobileSidebarHeight = Math.round(window.innerHeight * 0.42);
  const mobileQuery = window.matchMedia(MOBILE_LAYOUT_QUERY);
  let mobileLayout = mobileQuery.matches;

  const getViewportSidebarWidth = () => (mobileLayout ? 0 : sidebarWidth);
  const applyGeometry = () => {
    mobileLayout = mobileQuery.matches;
    root.classList.toggle("mobile-layout", mobileLayout);
    root.style.setProperty("--mobile-sidebar-height", `${mobileSidebarHeight}px`);
    root.style.setProperty("--sidebar-width", `${getViewportSidebarWidth()}px`);
    viewport.setSidebarWidth(getViewportSidebarWidth());
  };
  applyGeometry();

  // the window listeners of an in-progress sidebar resize, so destroy() can
  // remove them if teardown happens mid-drag
  let activeResize: AbortController | null = null;

  // Follows one pointer from `startEvent` until it lifts: `apply` sees the
  // start event and every move, `onUp` runs once after the listeners are gone.
  const trackPointerDrag = (startEvent: PointerEvent, apply: (event: PointerEvent) => void, onUp: () => void) => {
    apply(startEvent);
    const listeners = new AbortController();
    const { signal } = listeners;
    const stop = () => {
      listeners.abort();
      activeResize = null;
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== startEvent.pointerId) return;
      stop();
      onUp();
    };
    activeResize = listeners;
    window.addEventListener(
      "pointermove",
      (event) => {
        if (event.pointerId === startEvent.pointerId) apply(event);
      },
      { signal },
    );
    window.addEventListener("pointerup", up, { signal });
    window.addEventListener("pointercancel", up, { signal });
  };

  const applyHeight = (event: PointerEvent) => {
    mobileSidebarHeight = Math.max(180, Math.min(window.innerHeight * 0.72, window.innerHeight - event.clientY));
    applyGeometry();
  };
  const applyWidth = (event: PointerEvent) => {
    sidebarWidth = Math.max(260, Math.min(window.innerWidth - 240, event.clientX));
    applyGeometry();
  };
  const onResizeStart = (startEvent: PointerEvent) => trackPointerDrag(startEvent, mobileLayout ? applyHeight : applyWidth, applyGeometry);

  const onResize = () => {
    mobileSidebarHeight = Math.min(mobileSidebarHeight, window.innerHeight * 0.72);
    applyGeometry();
  };

  return {
    getViewportSidebarWidth,
    onResizeStart,
    attach: () => {
      window.addEventListener("resize", onResize);
      mobileQuery.addEventListener("change", onResize);
    },
    destroy: () => {
      activeResize?.abort();
      window.removeEventListener("resize", onResize);
      mobileQuery.removeEventListener("change", onResize);
    },
  };
}
