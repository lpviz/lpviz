import { getViewportTransitionConfig, subscribeViewportTransitionConfig } from "@/features/viewport/runtime/transitionConfig";
import type { SceneManager } from "../SceneManager";

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class TransitionController {
  private unsubscribe: () => void;
  private active = false;
  private completedRunId: number | null = null;
  private config = getViewportTransitionConfig();

  constructor(private sceneManager: SceneManager) {
    this.unsubscribe = subscribeViewportTransitionConfig(() => {
      this.config = getViewportTransitionConfig();
      if (!this.config.active) {
        this.completedRunId = null;
      }
      this.active = this.config.active;
      this.sceneManager.invalidate();
    });

    this.active = this.config.active;
    if (this.active) {
      this.sceneManager.invalidate();
    }
  }

  tick(): void {
    const config = this.config;
    if (!config.active) {
      this.active = false;
      return;
    }

    const duration = Math.max(1, config.duration);
    const elapsed = performance.now() - config.startTime;
    const progress = Math.max(0, Math.min(elapsed / duration, 1));
    const easedProgress = easeInOutCubic(progress);

    config.onFrame?.(progress, easedProgress);

    if (progress < 1) {
      this.sceneManager.invalidate();
      return;
    }

    if (this.completedRunId === config.runId) {
      return;
    }
    this.completedRunId = config.runId;
    config.onComplete?.();
  }

  dispose(): void {
    this.unsubscribe();
  }
}
