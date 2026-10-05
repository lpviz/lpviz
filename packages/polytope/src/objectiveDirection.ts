import { isObjectiveDirectionUnbounded } from "@lpviz/math/geometry";
import type { PointXY } from "@lpviz/math/types";
import { hasPolytopeLines, type PolytopeRepresentation } from "./polytopeTypes";

export { isObjectiveDirectionUnbounded } from "@lpviz/math/geometry";

export interface ObjectiveRotationStep {
  nextObjective: PointXY;
  nextDirection: 1 | -1;
}

export function computeObjectiveRotationStep({
  objectiveVector,
  angleStep,
  rotationDirection,
  polytope,
}: {
  objectiveVector: PointXY;
  angleStep: number;
  rotationDirection: 1 | -1;
  polytope: PolytopeRepresentation | null;
}): ObjectiveRotationStep {
  const angle = Math.atan2(objectiveVector.y, objectiveVector.x);
  const magnitude = Math.hypot(objectiveVector.x, objectiveVector.y);

  let nextDirection: 1 | -1 = rotationDirection;
  let nextAngle = angle + angleStep * nextDirection;

  if (hasPolytopeLines(polytope) && polytope.kind === "unbounded") {
    const candidateDirections: Array<1 | -1> = [rotationDirection, rotationDirection === 1 ? -1 : 1];
    const allowedDirection = candidateDirections.find((direction) => {
      const candidateAngle = angle + angleStep * direction;
      const candidateObjective: [number, number] = [magnitude * Math.cos(candidateAngle), magnitude * Math.sin(candidateAngle)];
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
    nextObjective: {
      x: magnitude * Math.cos(nextAngle),
      y: magnitude * Math.sin(nextAngle),
    },
    nextDirection,
  };
}
