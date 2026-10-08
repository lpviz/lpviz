import type { State } from "@/features/core/store";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import type { Vec } from "@lpviz/math/types";
import { Group } from "three";
import { PointCloud } from "../helpers/pointCloud";
import { RENDER_ORDER } from "../helpers/renderOrder";
import { rendersPlanarDrawing } from "../helpers/sceneVisibility";
import { SHARED_CIRCLE_TEXTURE, SHARED_SQUARE_TEXTURE } from "../helpers/sharedTextures";
import { PALETTE } from "../palette";
import { LayerBase } from "./base/LayerBase";

const VERTEX_PIXEL_SIZE = 10;

// The drawn vertices: circles, except the two ends of an open chain, which are squares.
export class PolytopeVerticesLayer extends LayerBase {
  readonly object3D = new Group();
  override readonly renderPass = "vertices" as const;
  override readonly invalidationKeys = ["polytope"] as const;
  private readonly circles = new PointCloud({ color: PALETTE.accent, pixelSize: VERTEX_PIXEL_SIZE, texture: SHARED_CIRCLE_TEXTURE, renderOrder: RENDER_ORDER.polytopeVertices, vertexColors: false });
  private readonly squares = new PointCloud({ color: PALETTE.accent, pixelSize: VERTEX_PIXEL_SIZE, texture: SHARED_SQUARE_TEXTURE, renderOrder: RENDER_ORDER.polytopeVertices, vertexColors: false });

  constructor() {
    super();
    this.object3D.add(this.circles.points, this.squares.points);
  }

  protected dependencies(state: State, snap: ViewportRenderSnapshot): readonly unknown[] {
    return [state.vertices, state.completionMode, state.polytope, snap.mode];
  }

  protected rebuild(state: State, snap: ViewportRenderSnapshot): void {
    const visible = state.vertices.length > 0 && rendersPlanarDrawing(snap.mode, state);
    this.object3D.visible = visible;
    if (!visible) return;

    const hasDerived = state.completionMode === "open" && state.polytope?.kind === "bounded" && state.polytope.vertices.length >= 3;
    const displayVertices = hasDerived && state.polytope?.kind === "bounded" ? state.polytope.vertices : state.vertices;
    const isAnchor = (index: number) => state.completionMode === "open" && !hasDerived && (index === 0 || index === displayVertices.length - 1);
    const circles = displayVertices.filter((_, index) => !isAnchor(index));
    const squares = displayVertices.filter((_, index) => isAnchor(index));
    this.circles.draw(circles.length, (positions) => writeVertices(positions, circles));
    this.squares.draw(squares.length, (positions) => writeVertices(positions, squares));
  }

  dispose(): void {
    this.circles.dispose();
    this.squares.dispose();
  }
}

function writeVertices(positions: Float32Array, vertices: readonly Vec[]): void {
  for (let i = 0; i < vertices.length; i++) {
    const vertex = vertices[i]!;
    positions[i * 3] = vertex[0];
    positions[i * 3 + 1] = vertex[1];
    positions[i * 3 + 2] = 0;
  }
}
