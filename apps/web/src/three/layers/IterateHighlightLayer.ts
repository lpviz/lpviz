import type { State } from "@/features/core/store";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { SHARED_CIRCLE_TEXTURE } from "../helpers/sharedTextures";
import { SinglePointSpriteLayer } from "./base/SinglePointSpriteLayer";

// Marks the current point of the path: the iterate the user is hovering in the
// solver log, or — while a replay sweeps — the head the line is currently
// drawn out to.
export class IterateHighlightLayer extends SinglePointSpriteLayer {
  constructor() {
    super({
      color: "#008000",
      pixelSize: 8 * 2,
      texture: SHARED_CIRCLE_TEXTURE,
      renderOrder: RENDER_ORDER.iterateHighlight,
      renderPass: "trace",
    });
  }

  protected selectorDeps(raw: State): readonly unknown[] {
    return [raw.highlightIteratePathIndex, raw.replayActive];
  }

  protected selectIndex(raw: State): number | null {
    // A replay's path ends on an interpolated head that slides along the
    // current segment, so taking its last point keeps this marker in lockstep
    // with the line — same buffer, same frame, same interpolated z — where an
    // integer index would snap from iterate to iterate. The index itself stays
    // on the last whole iterate passed, for consumers that need a real one
    // (EllipsoidLayer picks a per-iteration ellipse with it).
    if (raw.replayActive) {
      return raw.iteratePath.count > 0 ? raw.iteratePath.count - 1 : null;
    }
    return raw.highlightIteratePathIndex;
  }
}
