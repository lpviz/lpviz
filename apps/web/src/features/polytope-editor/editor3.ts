import { getState, setState } from "@/features/core/store";
import { bevelPlaneForEdge, centroid3, chamferPlaneForVertex, clampFaceOffset, deriveHullFromPoints3, enumerateEdges3, enumerateVertices3, isBounded3, type Edge3, type Plane3 } from "@lpviz/polytope/polytope3";
import type { PointXYZ } from "@lpviz/math/types";

// Smallest useful prism height; extrusion drags below this are treated as
// "not extruded yet" so a stray click can't commit a degenerate solid.
export const MIN_EXTRUDE_HEIGHT = 0.5;
// Chamfer depth as a fraction of the corner's distance from the centroid.
const CHAMFER_INSET_FRACTION = 0.3;
// Bevel depth as a fraction of the beveled edge's length.
const BEVEL_INSET_FRACTION = 0.2;
// Don't stack a new handle on top of an existing vertex.
const INSERT_DEDUP_DISTANCE = 1e-6;

// The solve trigger is injected at boot (same pattern as polytopeService):
// solid edits must rerun the active solver once the problem is solvable.
let notifyProblemChange: () => void = () => {};
export function setEditor3ProblemChangeNotifier(fn: () => void): void {
  notifyProblemChange = fn;
}

// Vertices are the editor's source of truth — the 2D editor's V-rep model
// lifted to 3D. Every edit lands in `vertices3`; the faces/planes are its
// convex hull, re-derived here. Plane-based operations (push/pull, chamfer,
// bevel, facet delete) run on the derived planes and adopt the resulting
// corner set as the new vertices.
function commitVertices3(points: PointXYZ[]): void {
  const polytope3 = deriveHullFromPoints3(points);
  setState({ vertices3: points, polytope3, planes: polytope3.planes });
  notifyProblemChange();
}

// Apply a plane edit by re-enumerating its corners and hulling them. Returns
// false (no state change) when the edit would degenerate the solid.
function adoptPlanes3(planes: Plane3[]): boolean {
  const corners = enumerateVertices3(planes);
  if (corners.length < 4) return false;
  if (deriveHullFromPoints3(corners).kind !== "bounded") return false;
  commitVertices3(corners);
  return true;
}

// Recompute the derived rep from restored vertices (undo/redo, share links).
export function refreshPolytope3(): void {
  const { vertices3 } = getState();
  const polytope3 = vertices3.length >= 4 ? deriveHullFromPoints3(vertices3) : null;
  setState({ polytope3, planes: polytope3?.planes ?? [] });
  notifyProblemChange();
}

// Visual anchor of the 3D objective arrow: the solid's centroid (the vector
// itself is unchanged — anchoring is display/interaction only). Falls back to
// the origin before a solid exists.
export function objectiveAnchor3(): PointXYZ {
  const { polytope3 } = getState();
  return polytope3 && polytope3.kind === "bounded" && polytope3.vertices.length > 0 ? centroid3(polytope3.vertices) : { x: 0, y: 0, z: 0 };
}

export function baseCentroidForSketch(): PointXYZ | null {
  const { vertices } = getState();
  if (vertices.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const v of vertices) {
    x += v.x;
    y += v.y;
  }
  return { x: x / vertices.length, y: y / vertices.length, z: 0 };
}

// Turn the closed base sketch into a prism of the given height and advance
// to objective selection: the prism's corners are simply the base polygon at
// z=0 and z=height.
export function commitExtrusion(height: number): boolean {
  const base = getState().vertices;
  if (base.length < 3 || height < MIN_EXTRUDE_HEIGHT) return false;
  const points: PointXYZ[] = [...base.map((v) => ({ x: v.x, y: v.y, z: 0 })), ...base.map((v) => ({ x: v.x, y: v.y, z: height }))];
  setState({ editor3Phase: "objective", extrudePreviewHeight: null });
  commitVertices3(points);
  return true;
}

// Drag a corner (or an inserted face handle) to a new position. The hull
// absorbs interior placements, so this is always safe; the handle stays in
// `vertices3` and can be dragged back out.
export function moveVertex3(index: number, point: PointXYZ): void {
  const { vertices3 } = getState();
  if (!vertices3[index]) return;
  commitVertices3(vertices3.map((v, i) => (i === index ? { ...point } : v)));
}

// Add a draggable vertex on the picked face point (the facet-split gesture:
// insert, then pull the new handle outward). Returns its index, or null when
// it would coincide with an existing vertex.
export function insertVertex3(point: PointXYZ): number | null {
  const { vertices3 } = getState();
  if (vertices3.some((v) => Math.hypot(v.x - point.x, v.y - point.y, v.z - point.z) < INSERT_DEDUP_DISTANCE)) {
    return null;
  }
  const updated = [...vertices3, { ...point }];
  commitVertices3(updated);
  return updated.length - 1;
}

// Remove a vertex; the hull re-derives. Refused when the remainder would no
// longer span a full-dimensional solid.
export function deleteVertex3(index: number): boolean {
  const { vertices3 } = getState();
  if (vertices3.length <= 4 || !vertices3[index]) return false;
  const updated = vertices3.filter((_, i) => i !== index);
  if (deriveHullFromPoints3(updated).kind !== "bounded") return false;
  commitVertices3(updated);
  return true;
}

// Push/pull: move the face with the given (fixed) normal to offset `targetD`,
// clamped so the polytope never collapses. The face is looked up by normal —
// hull derivation reorders planes between moves, so indices aren't stable
// across a drag but normals are.
export function applyFaceOffsetDrag(normal: PointXYZ, targetD: number): void {
  const { planes } = getState();
  let best = -1;
  let bestDot = 0.999;
  for (let i = 0; i < planes.length; i++) {
    const alignment = planes[i]![0]! * normal.x + planes[i]![1]! * normal.y + planes[i]![2]! * normal.z;
    if (alignment > bestDot) {
      bestDot = alignment;
      best = i;
    }
  }
  if (best < 0) return;
  const clampedD = clampFaceOffset(planes, best, targetD);
  if (Math.abs(clampedD - planes[best]![3]!) < 1e-12) return;
  adoptPlanes3(planes.map((p, i) => (i === best ? [p[0]!, p[1]!, p[2]!, clampedD] : p)));
}

// Live objective re-aim (tip drag in the ready phase) — solves on the fly,
// mirroring the 2D objective drag.
export function setObjectiveVector3(point: PointXYZ): void {
  setState({ objectiveVector3: { ...point } });
  notifyProblemChange();
}

// Commit the previewed objective and enter the solvable state.
export function commitObjective3(point: PointXYZ): void {
  setState({
    objectiveVector3: { ...point },
    currentObjective3: null,
    editor3Phase: "ready",
  });
  notifyProblemChange();
}

// Edges of the current solid, for hit-testing (empty until faces exist).
export function currentEdges3(): Edge3[] {
  const { polytope3 } = getState();
  return polytope3 && polytope3.kind === "bounded" ? enumerateEdges3(polytope3.faces) : [];
}

// Split off a new facet along an edge: a bevel plane whose normal bisects the
// two adjacent faces. Returns false when the cut would degenerate the solid.
export function applyEdgeBevel(edge: Edge3): boolean {
  const { planes, polytope3 } = getState();
  const a = polytope3?.vertices[edge.a];
  const b = polytope3?.vertices[edge.b];
  const first = planes[edge.planeIndices[0]];
  const second = planes[edge.planeIndices[1]];
  if (!polytope3 || !a || !b || !first || !second) return false;
  const midpoint: PointXYZ = {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: (a.z + b.z) / 2,
  };
  const edgeLength = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const plane = bevelPlaneForEdge(midpoint, first, second, edgeLength * BEVEL_INSET_FRACTION);
  if (!plane) return false;
  return adoptPlanes3([...planes, plane]);
}

// Delete a facet. Refused when the remaining half-spaces no longer bound a
// full-dimensional solid.
export function applyFaceRemoval(planeIndex: number): boolean {
  const { planes } = getState();
  if (planes.length <= 4 || !planes[planeIndex]) return false;
  const remaining = planes.filter((_, index) => index !== planeIndex);
  if (!isBounded3(remaining)) return false;
  // face indices shift after removal; drop any stale hover/highlight
  const applied = adoptPlanes3(remaining);
  if (applied) setState({ hoveredFaceIndex: null, highlightIndex: null });
  return applied;
}

// Cut the given corner off with a plane perpendicular to centroid->vertex.
// Returns false when the cut would degenerate the polytope.
export function applyVertexChamfer(vertexIndex: number): boolean {
  const { planes, polytope3 } = getState();
  const vertex = polytope3?.vertices[vertexIndex];
  if (!polytope3 || !vertex || polytope3.kind !== "bounded") return false;
  const center = centroid3(polytope3.vertices);
  const distance = Math.hypot(vertex.x - center.x, vertex.y - center.y, vertex.z - center.z);
  const plane = chamferPlaneForVertex(vertex, center, distance * CHAMFER_INSET_FRACTION);
  if (!plane) return false;
  return adoptPlanes3([...planes, plane]);
}
