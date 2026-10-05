import { createSignal } from "@/features/core/signal";

type ViewportTransitionConfig = {
  active: boolean;
  runId: number;
  startTime: number;
  duration: number;
  onFrame?: (progress: number, easedProgress: number) => void;
  onComplete?: () => void;
};

export const {
  set: setViewportTransitionConfig,
  reset: resetViewportTransitionConfig,
  subscribe: subscribeViewportTransitionConfig,
  get: getViewportTransitionConfig,
} = createSignal<ViewportTransitionConfig>({ active: false, runId: 0, startTime: 0, duration: 0 });
