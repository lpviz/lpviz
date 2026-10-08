// What the 2D and 3D controls share: listener tables and two-finger geometry.

type ListenerEntry = {
  [K in keyof GlobalEventHandlersEventMap]: readonly [EventTarget, K, (event: GlobalEventHandlersEventMap[K]) => void, AddEventListenerOptions?];
}[keyof GlobalEventHandlersEventMap];

// Registers the listeners in table order and returns the matching remover.
export function addListeners(entries: readonly ListenerEntry[]): () => void {
  for (const [target, type, handler, options] of entries) target.addEventListener(type, handler as EventListener, options);
  return () => {
    for (const [target, type, handler] of entries) target.removeEventListener(type, handler as EventListener);
  };
}

export const getTouchCenter = (touches: TouchList) => ({
  x: (touches[0]!.clientX + touches[1]!.clientX) / 2,
  y: (touches[0]!.clientY + touches[1]!.clientY) / 2,
});

export const getTouchDistance = (touches: TouchList) => Math.hypot(touches[1]!.clientX - touches[0]!.clientX, touches[1]!.clientY - touches[0]!.clientY);
