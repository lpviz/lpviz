import type { AppActions } from "@/app/appActions";

export const DEFAULT_SIDEBAR_WIDTH = 450;
const MOBILE_LAYOUT_QUERY = "(max-width: 700px) and (orientation: portrait)";

type Resizable = { sidebar: { updateWidth: (width: number) => void }; stage: { updateLayout: () => void } };

export type Layout = ReturnType<typeof createLayout>;

// Sidebar geometry: its desktop width, its mobile height, the mobile/desktop
// switch, and the handle drag that resizes it. `attach` wires the mounted
// sidebar and stage plus the window listeners; `destroy` removes them.
export function createLayout(root: HTMLElement, viewport: Pick<AppActions, "setSidebarWidth">) {
  let sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
  let mobileSidebarHeight = Math.round(window.innerHeight * 0.42);
  const mobileQuery = window.matchMedia(MOBILE_LAYOUT_QUERY);
  let mobileLayout = mobileQuery.matches;
  let mounted: Resizable | null = null;

  const getViewportSidebarWidth = () => (mobileLayout ? 0 : sidebarWidth);
  const applyLayoutMode = () => {
    mobileLayout = mobileQuery.matches;
    root.classList.toggle("mobile-layout", mobileLayout);
    root.style.setProperty("--mobile-sidebar-height", `${mobileSidebarHeight}px`);
  };
  applyLayoutMode();

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
    root.style.setProperty("--mobile-sidebar-height", `${mobileSidebarHeight}px`);
    viewport.setSidebarWidth(0);
    mounted?.stage.updateLayout();
  };
  const applyWidth = (event: PointerEvent) => {
    sidebarWidth = Math.max(260, Math.min(window.innerWidth - 240, event.clientX));
    mounted?.sidebar.updateWidth(sidebarWidth);
    viewport.setSidebarWidth(getViewportSidebarWidth());
    mounted?.stage.updateLayout();
  };
  const onResizeStart = (startEvent: PointerEvent) =>
    mobileLayout ? trackPointerDrag(startEvent, applyHeight, () => viewport.setSidebarWidth(0)) : trackPointerDrag(startEvent, applyWidth, () => viewport.setSidebarWidth(getViewportSidebarWidth()));

  const onResize = () => {
    mobileSidebarHeight = Math.min(mobileSidebarHeight, window.innerHeight * 0.72);
    applyLayoutMode();
    viewport.setSidebarWidth(getViewportSidebarWidth());
    mounted?.stage.updateLayout();
  };

  return {
    getSidebarWidth: () => sidebarWidth,
    getViewportSidebarWidth,
    isMobileLayout: () => mobileLayout,
    onResizeStart,
    attach: (resizable: Resizable) => {
      mounted = resizable;
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
