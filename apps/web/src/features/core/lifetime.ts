// The app's lifetime is one AbortSignal, aborted when the app is torn down (the dev server's hot
// reload): every store subscription, channel subscription and listener on something a mount did
// not make (the window, the document, another mount's canvas) takes it; a listener on a node the
// mount made goes with the node. What a mount sets up outside the DOM (observers, timers, the GL
// context) comes down with it through onAbort. Listeners fire in registration order, which is
// mount order.

/** Run `fn` when the app's lifetime ends. */
export const onAbort = (signal: AbortSignal, fn: () => void): void => signal.addEventListener("abort", fn, { once: true });
