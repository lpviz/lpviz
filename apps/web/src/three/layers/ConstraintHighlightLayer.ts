import type { State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import { type BoundingBox } from "@lpviz/math/bounds";
import type { Constraint, PointXY } from "@lpviz/math/types";
import { hasConstraints } from "@lpviz/polytope/polytope";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { rendersPlanarDrawing } from "../helpers/sceneVisibility";
import { lineDepthMaterial, lineGeometry, replaceLinePositions, setupLine } from "../helpers/sharedLineMaterials";
import { visibleBounds } from "../helpers/visibleBounds";
import { PALETTE } from "../palette";
import { LayerBase } from "./base/LayerBase";

const CONSTRAINT_LINE_THICKNESS = 2;
const EPS = 1e-10;

function clipLineToBounds(line: Constraint, b: BoundingBox): [PointXY, PointXY] | null {
  const [A, B, C] = line;
  if (Math.abs(A) < EPS && Math.abs(B) < EPS) return null;
  if (Math.abs(B) > Math.abs(A)) {
    return [
      { x: b.minX, y: (C - A * b.minX) / B },
      { x: b.maxX, y: (C - A * b.maxX) / B },
    ];
  }
  return [
    { y: b.minY, x: (C - B * b.minY) / A },
    { y: b.maxY, x: (C - B * b.maxY) / A },
  ];
}

export class ConstraintHighlightLayer extends LayerBase {
  readonly object3D = setupLine(new LineSegments2(lineGeometry(), lineDepthMaterial(PALETTE.accent, CONSTRAINT_LINE_THICKNESS, false)), RENDER_ORDER.constraintLines);
  // "grid" fires on zoom/resize/pan, which move the visible bounds this
  // layer clips against; the dependency check below keeps updates cheap.
  override readonly invalidationKeys = ["constraints", "grid"] as const;

  protected dependencies(state: State, snap: ViewportRenderSnapshot): readonly unknown[] {
    return [
      state.completionMode,
      state.highlightIndex,
      state.polytope,
      snap.mode,
      snap.orthographic.left,
      snap.orthographic.right,
      snap.orthographic.top,
      snap.orthographic.bottom,
      snap.target.x,
      snap.target.y,
      snap.unitsPerPixel,
      snap.width,
      snap.height,
      snap.scaleFactor,
    ];
  }

  protected override visibleIn(state: State, snap: ViewportRenderSnapshot): boolean {
    return state.completionMode !== "draft" && state.highlightIndex !== null && hasConstraints(state.polytope) && rendersPlanarDrawing(state, snap);
  }

  protected rebuild(state: State, snap: ViewportRenderSnapshot): void {
    const line = state.highlightIndex !== null && hasConstraints(state.polytope) ? state.polytope.constraints[state.highlightIndex] : undefined;
    if (!line) {
      this.object3D.visible = false;
      return;
    }

    const clipped = clipLineToBounds(line, visibleBounds(snap));
    if (!clipped) {
      this.object3D.visible = false;
      return;
    }

    const [start, end] = clipped;
    replaceLinePositions(this.object3D.geometry, [start.x, start.y, 0, end.x, end.y, 0]);

    this.object3D.material = lineDepthMaterial(PALETTE.accent, CONSTRAINT_LINE_THICKNESS, snap.mode === "3d");
    this.object3D.visible = true;
  }

  dispose(): void {
    this.object3D.geometry.dispose();
  }
}
