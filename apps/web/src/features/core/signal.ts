// A module-level value with change listeners: the shape shared by the mouse, render-snapshot
// and controls/transition config signals. Listeners fire in subscription order (Set iteration
// order) and are removed when their signal aborts, as the store's `on` does.
export function createSignal<T>(initial: T, equals?: (prev: T, next: T) => boolean) {
  let value = initial;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    get: () => value,
    set(next: T) {
      if (equals?.(value, next)) return;
      value = next;
      emit();
    },
    reset() {
      value = initial;
      emit();
    },
    subscribe(listener: () => void, signal: AbortSignal) {
      if (signal.aborted) return;
      listeners.add(listener);
      signal.addEventListener("abort", () => listeners.delete(listener), { once: true });
    },
  };
}
