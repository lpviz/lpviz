// A module-level value with change listeners: the shape shared by the mouse,
// render-snapshot, 3D-controls and transition signals. Listeners fire in
// subscription order (Set iteration order).
export function createSignal<T>(initial: T, equals?: (prev: T, next: T) => boolean) {
  let value = initial;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    get: () => value,
    set(next: T) {
      if (equals?.(value, next)) {
        return;
      }
      value = next;
      emit();
    },
    reset() {
      value = initial;
      emit();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
