type ViewportTransitionConfig = {
  active: boolean;
  runId: number;
  startTime: number;
  duration: number;
  onFrame?: (progress: number, easedProgress: number) => void;
  onComplete?: () => void;
};

const DEFAULT_VIEWPORT_TRANSITION_CONFIG: ViewportTransitionConfig = {
  active: false,
  runId: 0,
  startTime: 0,
  duration: 0,
};

let config = DEFAULT_VIEWPORT_TRANSITION_CONFIG;
const listeners = new Set<() => void>();

const emit = () => {
  listeners.forEach((listener) => listener());
};

export function setViewportTransitionConfig(nextConfig: ViewportTransitionConfig) {
  config = nextConfig;
  emit();
}

export function resetViewportTransitionConfig() {
  config = DEFAULT_VIEWPORT_TRANSITION_CONFIG;
  emit();
}

export function subscribeViewportTransitionConfig(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getViewportTransitionConfig() {
  return config;
}
