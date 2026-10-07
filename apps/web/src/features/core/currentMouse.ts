import type { Vec } from "@lpviz/math/types";
import { createSignal } from "./signal";

export const { get: getCurrentMouse, set: setCurrentMouse, subscribe: subscribeCurrentMouse } = createSignal<Vec | null>(null, (prev, next) => prev === next);
