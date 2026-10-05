import type { State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import type { PointXY } from "@lpviz/math/types";

export interface SceneContext {
  getSnapshot(): ViewportRenderSnapshot;
  getState(): State;
  getCurrentMouse(): PointXY | null;
}
