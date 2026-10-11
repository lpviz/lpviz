import type { AppActions } from "@/app/appActions";
import { el } from "@/ui/dom";
import { MOBILE_LAYOUT_QUERY } from "@/ui/media";

const DEFAULT_SIDEBAR_WIDTH = 450;

// Sidebar geometry: its desktop width, its mobile height, the mobile/desktop switch, and the
// handle whose drag resizes it. The stylesheet lays the sidebar, its handle and the gallery out
// from two root variables; the viewport runtime is told the width the sidebar takes from it.
// Returns the handle, for the canvas stage to place.
export function createLayout(root: HTMLElement, actions: Pick<AppActions, "setSidebarWidth">, signal: AbortSignal): HTMLElement {
  let sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
  let mobileSidebarHeight = Math.round(window.innerHeight * 0.42);
  const mobileQuery = window.matchMedia(MOBILE_LAYOUT_QUERY);
  let mobileLayout = mobileQuery.matches;

  const getViewportSidebarWidth = () => (mobileLayout ? 0 : sidebarWidth);
  const applyGeometry = () => {
    mobileLayout = mobileQuery.matches;
    root.style.setProperty("--mobile-sidebar-height", `${mobileSidebarHeight}px`);
    root.style.setProperty("--sidebar-width", `${getViewportSidebarWidth()}px`);
    actions.setSidebarWidth(getViewportSidebarWidth());
  };
  applyGeometry();

  // The handle between the sidebar and the canvas. Its press captures the pointer, so the moves
  // and the lift reach the handle wherever the pointer goes; on a phone it sets the sidebar's
  // height, on a desktop its width, and the lift re-applies the geometry once more.
  let dragging: number | null = null;
  const applyDrag = (event: PointerEvent) => {
    if (mobileLayout) mobileSidebarHeight = Math.max(180, Math.min(window.innerHeight * 0.72, window.innerHeight - event.clientY));
    else sidebarWidth = Math.max(260, Math.min(window.innerWidth - 240, event.clientX));
    applyGeometry();
  };
  const release = (event: PointerEvent) => {
    if (event.pointerId !== dragging) return;
    dragging = null;
    applyGeometry();
  };
  const handle = el("div", {
    id: "sidebarHandle",
    on: {
      pointerdown(event) {
        if (!event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        this.setPointerCapture(event.pointerId);
        dragging = event.pointerId;
        applyDrag(event);
      },
      pointermove(event) {
        if (event.pointerId === dragging) applyDrag(event);
      },
      pointerup: release,
      pointercancel: release,
    },
  });

  const onResize = () => {
    mobileSidebarHeight = Math.min(mobileSidebarHeight, window.innerHeight * 0.72);
    applyGeometry();
  };
  window.addEventListener("resize", onResize, { signal });
  mobileQuery.addEventListener("change", onResize, { signal });
  return handle;
}
