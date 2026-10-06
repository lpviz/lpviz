import { getState, setState } from "@/features/core/store";

const VIEWPORT_NAVIGATION_IDLE_MS = 100;

export type NavigationIdleTracker = ReturnType<typeof createNavigationIdleTracker>;

// Drives store.isNavigatingViewport: set when a navigation gesture begins or
// a frame arrives, cleared VIEWPORT_NAVIGATION_IDLE_MS after the last one.
export function createNavigationIdleTracker({ shouldUseExternal2DViewport }: { shouldUseExternal2DViewport: () => boolean }) {
  let navigationIdleTimeoutId: number | null = null;

  // external 2D xor external 3D owns navigation whenever no transition runs
  const isExternalViewportNavigationOwned = () => !getState().isTransitioning3D;

  const setViewportNavigationActive = (active: boolean) => {
    if (getState().isNavigatingViewport === active) {
      return;
    }
    setState({ isNavigatingViewport: active });
  };

  const clearViewportNavigationTimeout = () => {
    if (navigationIdleTimeoutId !== null) {
      clearTimeout(navigationIdleTimeoutId);
      navigationIdleTimeoutId = null;
    }
  };

  const beginViewportNavigation = () => {
    if (!isExternalViewportNavigationOwned()) {
      return;
    }
    clearViewportNavigationTimeout();
    setViewportNavigationActive(true);
  };

  const scheduleViewportNavigationEnd = () => {
    clearViewportNavigationTimeout();
    navigationIdleTimeoutId = window.setTimeout(() => {
      navigationIdleTimeoutId = null;
      if (!isExternalViewportNavigationOwned()) {
        return;
      }
      setViewportNavigationActive(false);
    }, VIEWPORT_NAVIGATION_IDLE_MS);
  };

  const notifyViewportNavigationFrame = () => {
    if (!shouldUseExternal2DViewport()) {
      return;
    }
    beginViewportNavigation();
    scheduleViewportNavigationEnd();
  };

  return {
    beginViewportNavigation,
    scheduleViewportNavigationEnd,
    notifyViewportNavigationFrame,
    // stop the idle timer and clear the flag (a transition start, teardown)
    clearActiveNavigation: () => {
      clearViewportNavigationTimeout();
      setViewportNavigationActive(false);
    },
  };
}
