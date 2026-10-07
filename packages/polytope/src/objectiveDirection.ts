import { isObjectiveDirectionUnbounded } from "@lpviz/math/geometry";
import type { Vec } from "@lpviz/math/types";
import { hasPolytopeLines, type PolytopeRepresentation } from "./polytopeTypes";

export { isObjectiveDirectionUnbounded } from "@lpviz/math/geometry";

export interface ObjectiveRotationStep {
  nextObjective: Vec;
  nextDirection: 1 | -1;
}

export function computeObjectiveRotationStep({
  objectiveVector,
  angleStep,
  rotationDirection,
  polytope,
}: {
  objectiveVector: Vec;
  angleStep: number;
  rotationDirection: 1 | -1;
  polytope: PolytopeRepresentation | null;
}): ObjectiveRotationStep {
  const angle = Math.atan2(objectiveVector[1], objectiveVector[0]);
  const magnitude = Math.hypot(objectiveVector[0], objectiveVector[1]);

  let nextDirection: 1 | -1 = rotationDirection;
  let nextAngle = angle + angleStep * nextDirection;

  if (hasPolytopeLines(polytope) && polytope.kind === "unbounded") {
    const candidateDirections: Array<1 | -1> = [rotationDirection, rotationDirection === 1 ? -1 : 1];
    const allowedDirection = candidateDirections.find((direction) => {
      const candidateAngle = angle + angleStep * direction;
      const candidateObjective: Vec = [magnitude * Math.cos(candidateAngle), magnitude * Math.sin(candidateAngle)];
      return !isObjectiveDirectionUnbounded(polytope.lines, candidateObjective);
    });

    if (allowedDirection !== undefined) {
      nextDirection = allowedDirection;
      nextAngle = angle + angleStep * nextDirection;
    }
    // When both directions lead into unbounded objective territory (the
    // bounded cone is narrower than angleStep), keep rotating rather than
    // stalling forever; the solver reports unboundedness for those frames.
  }

  return {
    nextObjective: [magnitude * Math.cos(nextAngle), magnitude * Math.sin(nextAngle)],
    nextDirection,
  };
}
