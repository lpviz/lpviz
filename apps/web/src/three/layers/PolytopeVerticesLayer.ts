import type { State } from "@/features/core/store";
import { derivedClosure } from "@/features/problem/selectors";
import type { ViewportRenderSnapshot } from "@/features/viewport/types";
import type { Vec } from "@lpviz/math/types";
import { Group } from "three";
import { PointCloud } from "../helpers/pointCloud";
import { rendersPlanarDrawing } from "../helpers/sceneVisibility";
import { PALETTE, SPRITE } from "../palette";
import { LayerBase } from "./base/LayerBase";

// The drawn vertices: circles, except the two ends of an open chain, which are squares.
export class PolytopeVerticesLayer extends LayerBase {
  readonly object3D = new Group();
  readonly slot = "polytopeVertices" as const;
  override readonly invalidationKeys = ["polytope"] as const;
  private readonly circles = this.own(new PointCloud({ color: PALETTE.accent, pixelSize: SPRITE.polytopeVertex, shape: "disc", slot: this.slot, vertexColors: false }));
  private readonly squares = this.own(new PointCloud({ color: PALETTE.accent, pixelSize: SPRITE.polytopeVertex, shape: "square", slot: this.slot, vertexColors: false }));

  constructor() {
    super();
    this.object3D.add(this.circles.object3D, this.squares.object3D);
  }

  protected override visibleIn(state: State, snap: ViewportRenderSnapshot): boolean {
    return state.vertices.length > 0 && rendersPlanarDrawing(state, snap);
  }

  protected dependencies(state: State, snap: ViewportRenderSnapshot): readonly unknown[] {
    return [state.vertices, state.completionMode, state.polytope, snap.mode];
  }

  protected rebuild(state: State): void {
    const derived = derivedClosure(state);
    const displayVertices = derived ?? state.vertices;
    const isAnchor = (index: number) => state.completionMode === "open" && !derived && (index === 0 || index === displayVertices.length - 1);
    const circles = displayVertices.filter((_, index) => !isAnchor(index));
    const squares = displayVertices.filter((_, index) => isAnchor(index));
    this.circles.draw(circles.length, (positions) => writeVertices(positions, circles));
    this.squares.draw(squares.length, (positions) => writeVertices(positions, squares));
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
