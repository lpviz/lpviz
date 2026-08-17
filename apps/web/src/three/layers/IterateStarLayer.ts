import type { State } from "@/features/core/store";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { SHARED_STAR_TEXTURE } from "../helpers/sharedTextures";
import { SinglePointSpriteLayer } from "./base/SinglePointSpriteLayer";

// Marks the final iterate of the solved path (the optimum), shown once any
// replay animation has finished playing out.
export class IterateStarLayer extends SinglePointSpriteLayer {
  constructor() {
    super({
      color: "#008000",
      pixelSize: 27,
      texture: SHARED_STAR_TEXTURE,
      renderOrder: RENDER_ORDER.iterateStar,
      renderPass: "overlay",
    });
  }

  protected selectorDeps(raw: State): readonly unknown[] {
    return [raw.replayActive];
  }

  protected selectIndex(raw: State): number | null {
    if (raw.iteratePath.count === 0) return null;
    // `replayActive` falls exactly when the replay ends — whether it played out
    // or was stopped — and both leave the full path on screen, so the marker is
    // always on the real optimum when it is shown
    if (raw.replayActive) return null;
    return raw.iteratePath.count - 1;
  }
}
