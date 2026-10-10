import { createSignal } from "@/features/core/signal";

type TransitionConfig = {
  active: boolean;
  runId: number;
  startTime: number;
  duration: number;
  onFrame?: (easedProgress: number) => void;
  onComplete?: () => void;
};

export const {
  set: setTransitionConfig,
  reset: resetTransitionConfig,
  subscribe: subscribeTransitionConfig,
  get: getTransitionConfig,
} = createSignal<TransitionConfig>({ active: false, runId: 0, startTime: 0, duration: 0 });
