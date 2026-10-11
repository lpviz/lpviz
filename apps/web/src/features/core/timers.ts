// The two one-at-a-time schedulers the app's controllers keep: a delay that restarts when
// scheduled again, and an animation frame that is never requested twice.

/** A delayed call with at most one pending: scheduling again restarts the delay. */
export function restartableTimeout() {
  let id: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (id !== null) clearTimeout(id);
    id = null;
  };
  return {
    get pending() {
      return id !== null;
    },
    clear,
    schedule(fn: () => void, delayMs: number) {
      clear();
      id = setTimeout(() => {
        id = null;
        fn();
      }, delayMs);
    },
  };
}

/** An animation frame with at most one pending: requesting while one is pending is a no-op. */
export function singleFrame() {
  let id: number | null = null;
  return {
    get pending() {
      return id !== null;
    },
    cancel() {
      if (id !== null) cancelAnimationFrame(id);
      id = null;
    },
    request(fn: FrameRequestCallback) {
      if (id !== null) return;
      id = requestAnimationFrame((timestamp) => {
        id = null;
        fn(timestamp);
      });
    },
  };
}
