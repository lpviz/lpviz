import type { PointXY } from "@lpviz/math/types";
import { createSignal } from "./signal";

export const { get: getCurrentMouse, set: setCurrentMouse, subscribe: subscribeCurrentMouse } = createSignal<PointXY | null>(null, (prev, next) => prev === next);
