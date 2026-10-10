import { getViewportTransitionConfig, subscribeViewportTransitionConfig } from "@/features/viewport/runtime/transitionConfig";
import type { SceneManager } from "../SceneManager";

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// Drives the 2D/3D transition the viewport runtime configures: each frame maps the wall clock
// onto its eased progress and hands it to the runtime, which publishes the snapshot for it.
export class TransitionController {
  private unsubscribe: () => void;
  private completedRunId: number | null = null;
  private config = getViewportTransitionConfig();

  constructor(private sceneManager: SceneManager) {
    this.unsubscribe = subscribeViewportTransitionConfig(() => {
      this.config = getViewportTransitionConfig();
      if (!this.config.active) this.completedRunId = null;
      this.sceneManager.invalidate();
    });
    this.sceneManager.addTick(this.tick);
    if (this.config.active) this.sceneManager.invalidate();
  }

  private tick = (): void => {
    const config = this.config;
    if (!config.active) return;

    const duration = Math.max(1, config.duration);
    const elapsed = performance.now() - config.startTime;
    const progress = Math.max(0, Math.min(elapsed / duration, 1));
    config.onFrame?.(progress, easeInOutCubic(progress));

    if (progress < 1) {
      this.sceneManager.invalidate();
      return;
    }
    if (this.completedRunId === config.runId) return;
    this.completedRunId = config.runId;
    config.onComplete?.();
  };

  dispose(): void {
    this.unsubscribe();
    this.sceneManager.removeTick(this.tick);
  }
}
